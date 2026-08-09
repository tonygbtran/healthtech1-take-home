export type Config = {
	port: number;
	databaseUrl: string;
	pollIntervalMs: number;
	maxAttempts: number;
	backoffBaseMs: number;
	emailRecipient: string;
};

const intFromEnv = (name: string, value: string | undefined, fallback: number): number => {
	if (value === undefined) return fallback;
	const parsed = parseInt(value, 10);
	if (Number.isNaN(parsed)) throw new Error(`Invalid integer for env var ${name}: "${value}"`);
	return parsed;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
	port: intFromEnv("PORT", env.PORT, 3000),
	databaseUrl: env.DATABASE_URL ?? "postgres://forms:forms@localhost:5432/forms",
	pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", env.POLL_INTERVAL_MS, 1000),
	maxAttempts: intFromEnv("MAX_ATTEMPTS", env.MAX_ATTEMPTS, 5),
	backoffBaseMs: intFromEnv("BACKOFF_BASE_MS", env.BACKOFF_BASE_MS, 1000),
	emailRecipient: env.EMAIL_RECIPIENT ?? "happyforms@bots.com",
});
