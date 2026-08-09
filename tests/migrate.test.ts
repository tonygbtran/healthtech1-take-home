import { Pool } from "pg";
import { migrate } from "../src/db/migrate";
import { createTestPool, truncateAll } from "./helpers/db";

describe("migrations", () => {
	let pool: Pool;

	beforeAll(() => {
		pool = createTestPool();
	});

	afterAll(async () => {
		await pool.end();
	});

	it("is a no-op when re-run against an up-to-date database", async () => {
		await migrate(pool);
		const applied = await migrate(pool);
		expect(applied).toEqual([]);
	});

	it("records applied migrations in schema_migrations", async () => {
		await migrate(pool);
		const { rows } = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
		expect(rows.map((r) => r.filename)).toContain("001_init.sql");
	});

	it("creates the forms, outbox_emails and form_events tables with expected columns", async () => {
		await migrate(pool);
		const columns = async (table: string) => {
			const { rows } = await pool.query(
				"SELECT column_name FROM information_schema.columns WHERE table_name = $1",
				[table],
			);
			return rows.map((r) => r.column_name);
		};

		expect(await columns("forms")).toEqual(
			expect.arrayContaining([
				"id",
				"application_reference",
				"raw_payload",
				"payload_hash",
				"status",
				"transformed_payload",
				"last_error",
				"attempt_count",
				"next_retry_at",
				"completed_at",
			]),
		);
		expect(await columns("outbox_emails")).toEqual(
			expect.arrayContaining(["form_id", "recipient", "subject", "body", "sent_at", "attempt_count", "next_retry_at"]),
		);
		expect(await columns("form_events")).toEqual(
			expect.arrayContaining(["form_id", "from_status", "to_status", "detail", "created_at"]),
		);
	});

	it("rejects updates and deletes on form_events (append-only)", async () => {
		await migrate(pool);
		await truncateAll(pool);
		await pool.query("INSERT INTO forms (application_reference, raw_payload, payload_hash) VALUES ('APP-EV', '{}', 'h')");
		await pool.query("INSERT INTO form_events (form_id, to_status) VALUES (1, 'received')");
		await expect(pool.query("UPDATE form_events SET to_status = 'validated'")).rejects.toThrow(/append-only/);
		await expect(pool.query("DELETE FROM form_events")).rejects.toThrow(/append-only/);
	});

	it("enforces uniqueness of application_reference", async () => {
		await migrate(pool);
		await truncateAll(pool);
		const insert = () =>
			pool.query("INSERT INTO forms (application_reference, raw_payload, payload_hash) VALUES ('APP-1', '{}', 'h')");
		await insert();
		await expect(insert()).rejects.toThrow(/duplicate key/);
	});
});
