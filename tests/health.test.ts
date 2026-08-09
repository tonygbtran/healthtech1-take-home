import request from "supertest";
import { createApp } from "../src/app";
import { Pool } from "pg";
import { migrate } from "../src/db/migrate";
import { createTestPool } from "./helpers/db";

describe("GET /health", () => {
	it("returns 200 ok when the database is reachable", async () => {
		const pool = createTestPool();
		try {
			await migrate(pool);
			const response = await request(createApp({ pool })).get("/health");
			expect(response.status).toBe(200);
			expect(response.body).toEqual({ status: "ok" });
		} finally {
			await pool.end();
		}
	});

	it("returns 503 when the database is not reachable", async () => {
		const pool = new Pool({
			connectionString: "postgres://forms:forms@localhost:59999/nope",
			connectionTimeoutMillis: 500,
		});
		try {
			const response = await request(createApp({ pool })).get("/health");
			expect(response.status).toBe(503);
			expect(response.body).toEqual({ status: "unavailable" });
		} finally {
			await pool.end();
		}
	});
});
