import { Router } from "express";
import { Pool } from "pg";
import { checkHealth } from "../services/health";

export const healthRouter = (pool: Pool): Router => {
	const router = Router();

	router.get("/health", async (_req, res) => {
		const { ok } = await checkHealth(pool);
		res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable" });
	});

	return router;
};
