import express, { Express, NextFunction, Request, Response } from "express";
import { Pool } from "pg";
import { healthRouter } from "./routes/health";
import { ingestRouter } from "./routes/ingest";

export type AppDeps = {
	pool: Pool;
};

export const createApp = ({ pool }: AppDeps): Express => {
	const app = express();

	app.use(express.json());
	// express.json rejects malformed JSON with a SyntaxError; the contract is
	// 400 for anything unparseable.
	app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
		if (err instanceof SyntaxError) {
			res.status(400).json({ error: "Request body must be valid JSON" });
			return;
		}
		next(err);
	});

	app.use(healthRouter(pool));
	app.use(ingestRouter(pool));

	return app;
};
