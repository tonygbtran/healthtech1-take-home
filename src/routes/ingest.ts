import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { ingestForm } from "../services/ingestion";

const isStorableBody = (req: Request): boolean => {
	// express.json sets body to {} when no body was sent at all; an absent
	// content-length with no transfer-encoding means exactly that.
	const hasBodyBytes =
		(req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
		req.headers["transfer-encoding"] !== undefined;
	if (!hasBodyBytes) return false;
	const body = req.body;
	return typeof body === "object" && body !== null && !Array.isArray(body);
};

export const ingestRouter = (pool: Pool): Router => {
	const router = Router();

	router.post("/ingest", async (req: Request, res: Response) => {
		if (!isStorableBody(req)) {
			res.status(400).json({ error: "Request body must be a JSON object" });
			return;
		}
		try {
			const result = await ingestForm(pool, req.body);
			res.status(202).json(result);
		} catch (error) {
			console.error("[ingest] failed to store payload", error);
			res.status(500).json({ error: "Failed to store payload" });
		}
	});

	return router;
};
