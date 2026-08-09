import { request as httpRequest } from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { createTestPool, truncateAll } from "./helpers/db";
import { example } from "./helpers/examples";

describe("POST /ingest", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = createTestPool();
		await migrate(pool);
	});

	beforeEach(async () => {
		await truncateAll(pool);
	});

	afterAll(async () => {
		await pool.end();
	});

	const app = () => createApp({ pool });

	it.each(["person_one.json", "person_two.json", "person_three.json"])(
		"stores %s raw and marks it validated with a 202",
		async (file) => {
			const payload = example(file);
			const response = await request(app()).post("/ingest").send(payload);

			expect(response.status).toBe(202);
			expect(response.body.outcome).toBe("validated");

			const { rows } = await pool.query(
				"SELECT raw_payload, payload_hash, status, last_error FROM forms WHERE application_reference = $1",
				[payload.application_reference],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].raw_payload).toEqual(payload);
			expect(rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(rows[0].status).toBe("validated");
			expect(rows[0].last_error).toBeNull();

			const events = await pool.query(
				"SELECT from_status, to_status FROM form_events ORDER BY id",
			);
			expect(events.rows).toEqual([
				{ from_status: null, to_status: "received" },
				{ from_status: "received", to_status: "validated" },
			]);
		},
	);

	it("stores a schema-invalid payload as validation_failed with a 202 and error detail", async () => {
		const payload: Record<string, unknown> = { ...example("person_one.json"), email: 42, gender: "dragon" };
		const response = await request(app()).post("/ingest").send(payload);

		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("validation_failed");

		const { rows } = await pool.query(
			"SELECT raw_payload, status, last_error FROM forms WHERE application_reference = $1",
			[payload.application_reference],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("validation_failed");
		expect(rows[0].raw_payload).toEqual(payload);
		expect(rows[0].last_error).not.toBeNull();
		expect(JSON.stringify(rows[0].last_error)).toContain("email");

		const events = await pool.query("SELECT from_status, to_status FROM form_events ORDER BY id");
		expect(events.rows).toEqual([
			{ from_status: null, to_status: "received" },
			{ from_status: "received", to_status: "validation_failed" },
		]);
	});

	it("stores a payload with no usable application_reference under a synthetic reference", async () => {
		const response = await request(app()).post("/ingest").send({ hello: "world" });

		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("validation_failed");

		const { rows } = await pool.query("SELECT application_reference, raw_payload, status FROM forms");
		expect(rows).toHaveLength(1);
		expect(rows[0].application_reference).toMatch(/^unknown-[0-9a-f]{16}$/);
		expect(rows[0].raw_payload).toEqual({ hello: "world" });
		expect(rows[0].status).toBe("validation_failed");
	});

	it("returns 400 for unparseable JSON and stores nothing", async () => {
		const response = await request(app())
			.post("/ingest")
			.set("Content-Type", "application/json")
			.send('{"not json');

		expect(response.status).toBe(400);
		const { rows } = await pool.query("SELECT count(*)::int AS n FROM forms");
		expect(rows[0].n).toBe(0);
	});

	it("returns 400 for a non-object body (array) and stores nothing", async () => {
		const response = await request(app())
			.post("/ingest")
			.set("Content-Type", "application/json")
			.send("[1,2,3]");

		expect(response.status).toBe(400);
		const { rows } = await pool.query("SELECT count(*)::int AS n FROM forms");
		expect(rows[0].n).toBe(0);
	});

	it("returns 400 for an empty body and stores nothing", async () => {
		const response = await request(app()).post("/ingest").set("Content-Type", "application/json").send("");

		expect(response.status).toBe(400);
		const { rows } = await pool.query("SELECT count(*)::int AS n FROM forms");
		expect(rows[0].n).toBe(0);
	});

	it("strips unknown fields from validated data but keeps them in raw_payload", async () => {
		const payload: Record<string, unknown> = { ...example("person_one.json"), nhs_number: "999" };
		const response = await request(app()).post("/ingest").send(payload);

		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("validated");

		const { rows } = await pool.query(
			"SELECT raw_payload FROM forms WHERE application_reference = $1",
			[payload.application_reference],
		);
		expect(rows[0].raw_payload.nhs_number).toBe("999");

		const events = await pool.query(
			"SELECT detail FROM form_events WHERE to_status = 'validated'",
		);
		expect(events.rows[0].detail.strippedFields).toEqual(["nhs_number"]);
	});

	// supertest rewrites the Transfer-Encoding header, so drive raw http here.
	it("accepts a valid form sent with chunked transfer encoding (no content-length)", async () => {
		const server = app().listen(0);
		try {
			const port = (server.address() as AddressInfo).port;
			const status = await new Promise<number>((resolve, reject) => {
				const req = httpRequest(
					{
						port,
						path: "/ingest",
						method: "POST",
						headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
					},
					(res) => {
						res.resume();
						res.on("end", () => resolve(res.statusCode ?? 0));
					},
				);
				req.on("error", reject);
				req.end(JSON.stringify(example("person_one.json")));
			});
			expect(status).toBe(202);
		} finally {
			server.close();
		}
	});

	it("responds 202 duplicate for a resend of the same application_reference", async () => {
		const payload = example("person_one.json");
		await request(app()).post("/ingest").send(payload);
		const response = await request(app()).post("/ingest").send(payload);

		expect(response.status).toBe(202);
		expect(response.body.outcome).toBe("duplicate");

		const { rows } = await pool.query("SELECT count(*)::int AS n FROM forms");
		expect(rows[0].n).toBe(1);
	});
});
