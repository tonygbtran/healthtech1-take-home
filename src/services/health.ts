import { Pool } from "pg";

export type HealthStatus = { ok: boolean };

export const checkHealth = async (pool: Pool): Promise<HealthStatus> => {
	try {
		await pool.query("SELECT 1");
		return { ok: true };
	} catch {
		return { ok: false };
	}
};
