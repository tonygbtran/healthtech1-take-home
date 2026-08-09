import express, { Express, Request, Response } from "express";
import { Pool } from "pg";
import { healthRouter } from "./routes/health";

export type AppDeps = {
	pool: Pool;
};

export const createApp = ({ pool }: AppDeps): Express => {
	const app = express();

	app.use(express.json());
	app.use(healthRouter(pool));

	app.post("/ingest", (_req: Request, res: Response) => {
		res.json({ message: "Ingesting form data" });
	});

	return app;
};
