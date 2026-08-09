import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { EmailSender, tick, WorkerDeps } from "../src/services/worker";
import { createTestPool, truncateAll } from "./helpers/db";
import { example } from "./helpers/examples";
import { alwaysSucceedEmail, alwaysSucceedGeocoder } from "./helpers/worker";

const alwaysFailEmail: EmailSender = {
	sendEmail: async () => ({ statusCode: 500, body: undefined }),
};

const failNThenSucceedEmail = (failures: number): EmailSender & { calls: () => number } => {
	let calls = 0;
	return {
		sendEmail: async () => {
			calls += 1;
			return { statusCode: calls <= failures ? 500 : 200, body: undefined };
		},
		calls: () => calls,
	};
};

const config = { maxAttempts: 5, backoffBaseMs: 1000, emailRecipient: "happyforms@bots.com" };

describe("guaranteed email via transactional outbox", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = createTestPool();
		await migrate(pool);
	});

	beforeEach(async () => {
		await truncateAll(pool);
	});

	afterAll(async () => {
		await pool.end();
	});

	const deps = (emailSender: EmailSender): WorkerDeps => ({ pool, geocoder: alwaysSucceedGeocoder, emailSender });

	const ingest = async (payload: Record<string, unknown>) => {
		const response = await request(createApp({ pool })).post("/ingest").send(payload);
		expect(response.status).toBe(202);
	};

	const formRow = async (reference: string) => {
		const { rows } = await pool.query(
			"SELECT id, status, completed_at FROM forms WHERE application_reference = $1",
			[reference],
		);
		return rows[0];
	};

	const outboxRows = async () => {
		const { rows } = await pool.query(
			"SELECT form_id, recipient, subject, body, sent_at, attempt_count, next_retry_at FROM outbox_emails ORDER BY id",
		);
		return rows;
	};

	it("inserts the outbox row in the same transaction that completes the form", async () => {
		const payload = example("person_one.json");
		await ingest(payload);

		// Email provider is down for the whole tick: the form still completes
		// and the outbox row exists, unsent — they were written atomically.
		await tick(deps(alwaysFailEmail), config);

		const form = await formRow(payload.application_reference as string);
		expect(form.status).toBe("completed");

		const rows = await outboxRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].form_id).toBe(form.id);
		expect(rows[0].recipient).toBe("happyforms@bots.com");
		expect(rows[0].sent_at).toBeNull();
	});

	it("creates no outbox row for forms that do not complete", async () => {
		const payload: Record<string, unknown> = { ...example("person_one.json"), email: 42 };
		await ingest(payload);

		await tick(deps(alwaysSucceedEmail), config);

		expect((await formRow(payload.application_reference as string)).status).toBe("validation_failed");
		expect(await outboxRows()).toHaveLength(0);
	});

	it("sends unsent emails and stamps sent_at", async () => {
		const payload = example("person_one.json");
		await ingest(payload);

		const t0 = new Date("2026-08-09T10:00:00Z");
		await tick(deps(alwaysSucceedEmail), config, () => t0);

		const rows = await outboxRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].sent_at).toEqual(t0);
		expect(rows[0].attempt_count).toBe(1);
		expect(rows[0].subject).toContain(payload.application_reference as string);
	});

	it("retries a fail-twice-then-succeed provider with growing backoff, recording one send", async () => {
		const emailSender = failNThenSucceedEmail(2);
		const payload = example("person_one.json");
		await ingest(payload);

		const t0 = new Date("2026-08-09T10:00:00Z");
		await tick(deps(emailSender), config, () => t0);

		let rows = await outboxRows();
		expect(rows[0].sent_at).toBeNull();
		expect(rows[0].attempt_count).toBe(1);
		const firstRetryAt = rows[0].next_retry_at as Date;
		expect(firstRetryAt.getTime()).toBe(t0.getTime() + 1000);

		// Before the retry window opens: nothing happens.
		await tick(deps(emailSender), config, () => new Date(t0.getTime() + 500));
		rows = await outboxRows();
		expect(rows[0].attempt_count).toBe(1);

		const t1 = firstRetryAt;
		await tick(deps(emailSender), config, () => t1);
		rows = await outboxRows();
		expect(rows[0].sent_at).toBeNull();
		expect(rows[0].attempt_count).toBe(2);
		const secondRetryAt = rows[0].next_retry_at as Date;
		// Backoff grows between attempts.
		expect(secondRetryAt.getTime() - t1.getTime()).toBeGreaterThan(firstRetryAt.getTime() - t0.getTime());

		await tick(deps(emailSender), config, () => secondRetryAt);
		rows = await outboxRows();
		expect(rows[0].sent_at).toEqual(secondRetryAt);
		expect(rows[0].attempt_count).toBe(3);
		expect(emailSender.calls()).toBe(3);

		// Sent rows are never retried.
		await tick(deps(emailSender), config, () => new Date(secondRetryAt.getTime() + 60000));
		expect(emailSender.calls()).toBe(3);
	});

	it("keeps retrying emails beyond the worker's form attempt cap", async () => {
		const failures = config.maxAttempts + 2;
		const emailSender = failNThenSucceedEmail(failures);
		const payload = example("person_one.json");
		await ingest(payload);

		let now = new Date("2026-08-09T10:00:00Z");
		await tick(deps(emailSender), config, () => now);
		for (let i = 0; i < failures; i += 1) {
			const { rows } = await pool.query("SELECT next_retry_at FROM outbox_emails");
			now = rows[0].next_retry_at as Date;
			await tick(deps(emailSender), config, () => now);
		}

		const rows = await outboxRows();
		expect(rows[0].sent_at).not.toBeNull();
		expect(rows[0].attempt_count).toBe(failures + 1);
	});

	it("leaves the form completed when email delivery fails", async () => {
		const payload = example("person_one.json");
		await ingest(payload);

		await tick(deps(alwaysFailEmail), config);

		const form = await formRow(payload.application_reference as string);
		expect(form.status).toBe("completed");
		expect(form.completed_at).not.toBeNull();
	});
});
