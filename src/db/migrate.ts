import fs from "fs";
import path from "path";
import { Pool } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

// Forward-only migration runner: applies each .sql file in name order exactly
// once, recording applied filenames in schema_migrations.
export const migrate = async (pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> => {
	await pool.query(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
	);

	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	const applied: string[] = [];
	const client = await pool.connect();
	try {
		// Serialise concurrent runners (e.g. app boot racing a manual migrate).
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(hashtext('schema_migrations'))");
		const { rows } = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
		const done = new Set(rows.map((r) => r.filename));

		for (const file of files) {
			if (done.has(file)) continue;
			const sql = fs.readFileSync(path.join(dir, file), "utf8");
			await client.query(sql);
			await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
			applied.push(file);
		}
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
	return applied;
};

export const migrateAndLog = async (pool: Pool): Promise<void> => {
	const applied = await migrate(pool);
	console.log(applied.length > 0 ? `Applied migrations: ${applied.join(", ")}` : "No pending migrations");
};
