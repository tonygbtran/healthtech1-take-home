import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { Geocoder, tick } from "../src/services/worker";
import { createTestPool, truncateAll } from "./helpers/db";
import { example } from "./helpers/examples";

const alwaysSucceed: Geocoder = {
	lookupPostcode: async () => ({ statusCode: 200, body: { longitude: 50.05, latitude: -5.05 } }),
};

const config = { maxAttempts: 5, backoffBaseMs: 1000 };

describe("dedupe & corrections", () => {
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

	const ingest = (payload: Record<string, unknown>) => request(createApp({ pool })).post("/ingest").send(payload);

	const formRow = async (reference: string) => {
		const { rows } = await pool.query(
			`SELECT id, raw_payload, payload_hash, status, transformed_payload, completed_at,
			        attempt_count, next_retry_at, last_error, updated_at
			 FROM forms WHERE application_reference = $1`,
			[reference],
		);
		return rows[0];
	};

	const events = async () => {
		const { rows } = await pool.query("SELECT from_status, to_status, detail FROM form_events ORDER BY id");
		return rows;
	};

	it("treats an identical resend as an idempotent 202 no-op with a duplicate_ignored audit event", async () => {
		const payload = example("person_one.json");
		await ingest(payload);
		const before = await formRow(payload.application_reference as string);

		const response = await ingest(payload);

		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("duplicate");

		const after = await formRow(payload.application_reference as string);
		expect(after).toEqual(before);

		const { rows } = await pool.query("SELECT count(*)::int AS n FROM forms");
		expect(rows[0].n).toBe(1);

		const auditEvents = await events();
		expect(auditEvents).toContainEqual({
			from_status: "validated",
			to_status: "validated",
			detail: { event: "duplicate_ignored" },
		});
	});

	it("accepts a correction before completion: raw payload replaced, hash updated, reprocessed to completed", async () => {
		const payload = example("person_one.json");
		await ingest(payload);
		const before = await formRow(payload.application_reference as string);

		const corrected = { ...payload, email: "corrected@example.com" };
		const response = await ingest(corrected);

		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("corrected");

		const after = await formRow(payload.application_reference as string);
		expect(after.raw_payload).toEqual(corrected);
		expect(after.payload_hash).not.toBe(before.payload_hash);
		// Re-validated immediately, same as a fresh submission.
		expect(after.status).toBe("validated");

		await tick({ pool, geocoder: alwaysSucceed }, config);

		const completed = await formRow(payload.application_reference as string);
		expect(completed.status).toBe("completed");
		expect(completed.transformed_payload.email).toBe("corrected@example.com");
	});

	it("discards a correction after completion: 202, stored data unchanged, correction_discarded audit event", async () => {
		const payload = example("person_one.json");
		await ingest(payload);
		await tick({ pool, geocoder: alwaysSucceed }, config);
		const before = await formRow(payload.application_reference as string);
		expect(before.status).toBe("completed");

		const corrected = { ...payload, email: "too-late@example.com" };
		const response = await ingest(corrected);

		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("correction_discarded");

		const after = await formRow(payload.application_reference as string);
		expect(after).toEqual(before);

		const auditEvents = await events();
		expect(auditEvents).toContainEqual({
			from_status: "completed",
			to_status: "completed",
			detail: { event: "correction_discarded" },
		});
	});

	it("lets a correction of a validation_failed form flow through to completed (feedback-email scenario)", async () => {
		const payload = example("person_one.json");
		const broken = { ...payload, email: 42 };
		const first = await ingest(broken);
		expect(first.body.outcome).toBe("validation_failed");

		const response = await ingest(payload);
		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("corrected");

		const row = await formRow(payload.application_reference as string);
		expect(row.status).toBe("validated");
		expect(row.last_error).toBeNull();

		await tick({ pool, geocoder: alwaysSucceed }, config);

		const completed = await formRow(payload.application_reference as string);
		expect(completed.status).toBe("completed");
		expect(completed.transformed_payload.email).toBe(payload.email);
	});

	it("does not complete with stale data when a correction lands mid-processing", async () => {
		const payload = example("person_one.json");
		await ingest(payload);

		// Geocoder fake that races a correction in while the worker holds the
		// old payload in memory.
		const correctionDuringGeocode: Geocoder = {
			lookupPostcode: async () => {
				await ingest({ ...payload, email: "corrected@example.com" });
				return { statusCode: 200, body: { longitude: 50.05, latitude: -5.05 } };
			},
		};

		await tick({ pool, geocoder: correctionDuringGeocode }, config);

		// The stale completion must be skipped; the corrected payload completes
		// on the next tick.
		const raced = await formRow(payload.application_reference as string);
		expect(raced.status).toBe("validated");
		expect(raced.completed_at).toBeNull();

		await tick({ pool, geocoder: alwaysSucceed }, config);

		const completed = await formRow(payload.application_reference as string);
		expect(completed.status).toBe("completed");
		expect(completed.transformed_payload.email).toBe("corrected@example.com");

		const { rows } = await pool.query(
			"SELECT count(*)::int AS n FROM form_events WHERE to_status = 'completed' AND from_status = 'geocoded'",
		);
		expect(rows[0].n).toBe(1);
	});

	it("invariant: a form never completes twice and its transformed payload never changes after completion", async () => {
		const payload = example("person_one.json");
		await ingest(payload);
		await tick({ pool, geocoder: alwaysSucceed }, config);
		const before = await formRow(payload.application_reference as string);

		// Identical resend, then a correction, then more ticks.
		await ingest(payload);
		await ingest({ ...payload, email: "changed@example.com" });
		await tick({ pool, geocoder: alwaysSucceed }, config);
		await tick({ pool, geocoder: alwaysSucceed }, config);

		const after = await formRow(payload.application_reference as string);
		expect(after.transformed_payload).toEqual(before.transformed_payload);
		expect(after.completed_at).toEqual(before.completed_at);
		expect(after.status).toBe("completed");

		const { rows } = await pool.query(
			"SELECT count(*)::int AS n FROM form_events WHERE to_status = 'completed' AND from_status = 'geocoded'",
		);
		expect(rows[0].n).toBe(1);
	});
});
