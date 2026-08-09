import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { findFailedForms } from "../repositories/forms";
import { retryAllFailed, retryByReference } from "../services/retry";

export const retryRouter = (pool: Pool): Router => {
	const router = Router();

	router.get("/forms/failed", async (_req: Request, res: Response) => {
		try {
			const failed = await findFailedForms(pool);
			res.status(200).json({
				forms: failed.map((form) => ({
					applicationReference: form.application_reference,
					status: form.status,
					attemptCount: form.attempt_count,
					lastError: form.last_error,
					updatedAt: form.updated_at,
				})),
			});
		} catch (error) {
			console.error("[retry] failed to list parked forms", error);
			res.status(500).json({ error: "Failed to list parked forms" });
		}
	});

	router.post("/retry", async (req: Request, res: Response) => {
		const applicationReference = req.body?.applicationReference;
		if (applicationReference !== undefined && (typeof applicationReference !== "string" || applicationReference === "")) {
			res.status(400).json({ error: "applicationReference must be a non-empty string" });
			return;
		}
		try {
			const result =
				applicationReference !== undefined
					? await retryByReference(pool, applicationReference)
					: await retryAllFailed(pool);
			switch (result.outcome) {
				case "retried":
					res.status(200).json({ retried: result.retried });
					return;
				case "not_found":
					res.status(404).json({ error: `No form with application reference ${applicationReference}` });
					return;
				case "not_failed":
					res.status(409).json({
						error: `Form is ${result.status}, not parked; only failed forms can be retried`,
					});
					return;
			}
		} catch (error) {
			console.error("[retry] retry failed", error);
			res.status(500).json({ error: "Retry failed" });
		}
	});

	return router;
};
