import request from "supertest";
import { createApp } from "../src/app";
import { createTestPool } from "./helpers/db";

describe("POST /ingest", () => {
	it("should return 200", async () => {
		const pool = createTestPool();
		try {
			const response = await request(createApp({ pool })).post("/ingest");
			expect(response.status).toBe(200);
		} finally {
			await pool.end();
		}
	});
});
