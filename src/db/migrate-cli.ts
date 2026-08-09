import { loadConfig } from "../config";
import { migrateAndLog } from "./migrate";
import { createPool } from "./pool";

const main = async () => {
	const pool = createPool(loadConfig().databaseUrl);
	try {
		await migrateAndLog(pool);
	} finally {
		await pool.end();
	}
};

main().catch((err) => {
	console.error("Migration failed", err);
	process.exit(1);
});
