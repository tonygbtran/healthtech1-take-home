import { createApp } from "./app";
import { loadConfig } from "./config";
import { migrateAndLog } from "./db/migrate";
import { createPool } from "./db/pool";

const main = async () => {
	const config = loadConfig();
	const pool = createPool(config.databaseUrl);

	await migrateAndLog(pool);

	const app = createApp({ pool });
	app.listen(config.port, () => {
		console.log(`Server is running on http://localhost:${config.port}`);
	});
};

main().catch((err) => {
	console.error("Failed to start", err);
	process.exit(1);
});
