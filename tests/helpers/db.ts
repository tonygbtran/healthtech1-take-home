import { Pool } from "pg";
import { createPool } from "../../src/db/pool";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://forms:forms@localhost:5433/forms_test";

export const createTestPool = (): Pool => createPool(TEST_DATABASE_URL);

export const truncateAll = async (pool: Pool): Promise<void> => {
	await pool.query("TRUNCATE forms, outbox_emails, form_events RESTART IDENTITY CASCADE");
};
