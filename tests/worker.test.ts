import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { Geocoder } from "../src/services/worker";
import { createTestPool, truncateAll } from "./helpers/db";
import { example } from "./helpers/examples";
import { alwaysSucceedGeocoder as alwaysSucceed, tickForms as tick } from "./helpers/worker";

const config = { maxAttempts: 5, backoffBaseMs: 1000 };

describe("worker tick", () => {
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

	const ingest = async (payload: Record<string, unknown>) => {
		const response = await request(createApp({ pool })).post("/ingest").send(payload);
		expect(response.status).toBe(202);
	};

	const formRow = async (reference: string) => {
		const { rows } = await pool.query(
			"SELECT status, transformed_payload, completed_at, attempt_count, next_retry_at, last_error FROM forms WHERE application_reference = $1",
			[reference],
		);
		return rows[0];
	};

	const events = async () => {
		const { rows } = await pool.query("SELECT from_status, to_status FROM form_events ORDER BY id");
		return rows;
	};

	it("advances a validated form to completed with transformed payload and completed_at", async () => {
		const payload = example("person_one.json");
		await ingest(payload);

		await tick({ pool, geocoder: alwaysSucceed }, config);

		const row = await formRow(payload.application_reference as string);
		expect(row.status).toBe("completed");
		expect(row.completed_at).not.toBeNull();
		expect(row.transformed_payload).toEqual({
			sessionId: payload.session_id,
			applicationReference: payload.application_reference,
			firstName: "John",
			lastName: "Doe",
			email: "john.doe@example.com",
			gender: "male",
			dateOfBirth: new Date("1990-01-01").toISOString(),
			phoneNumber: "07123456789",
			mobileNumber: "07123456789",
			addressLine1: "Stratford Village Surgery",
			addressLine2: "50C Romford Road",
			addressLine3: "London",
			postcode: "E15 4BZ",
			country: "United Kingdom",
			longitude: 50.05,
			latitude: -5.05,
		});

		expect(await events()).toEqual([
			{ from_status: null, to_status: "received" },
			{ from_status: "received", to_status: "validated" },
			{ from_status: "validated", to_status: "geocoded" },
			{ from_status: "geocoded", to_status: "completed" },
		]);
	});

	it("backs off exponentially on geocode failure and parks at the attempt cap", async () => {
		const alwaysFail: Geocoder = { lookupPostcode: async () => ({ statusCode: 500 }) };
		const payload = example("person_one.json");
		const reference = payload.application_reference as string;
		await ingest(payload);

		const t0 = new Date("2026-08-09T10:00:00Z");
		const capConfig = { maxAttempts: 3, backoffBaseMs: 1000 };

		await tick({ pool, geocoder: alwaysFail }, capConfig, () => t0);
		let row = await formRow(reference);
		expect(row.status).toBe("validated");
		expect(row.attempt_count).toBe(1);
		expect(row.next_retry_at).toEqual(new Date(t0.getTime() + 1000));
		expect(row.last_error).toEqual({ step: "geocode", statusCode: 500 });

		// Before the retry window opens: not eligible, nothing changes.
		await tick({ pool, geocoder: alwaysFail }, capConfig, () => new Date(t0.getTime() + 500));
		row = await formRow(reference);
		expect(row.attempt_count).toBe(1);

		const t1 = new Date(t0.getTime() + 1000);
		await tick({ pool, geocoder: alwaysFail }, capConfig, () => t1);
		row = await formRow(reference);
		expect(row.status).toBe("validated");
		expect(row.attempt_count).toBe(2);
		expect(row.next_retry_at).toEqual(new Date(t1.getTime() + 2000));

		const t2 = new Date(t1.getTime() + 2000);
		await tick({ pool, geocoder: alwaysFail }, capConfig, () => t2);
		row = await formRow(reference);
		expect(row.status).toBe("geocode_failed");
		expect(row.attempt_count).toBe(3);
		expect(row.next_retry_at).toBeNull();

		expect(await events()).toEqual([
			{ from_status: null, to_status: "received" },
			{ from_status: "received", to_status: "validated" },
			{ from_status: "validated", to_status: "geocode_failed" },
		]);

		// Parked forms are no longer picked up.
		await tick({ pool, geocoder: alwaysFail }, capConfig, () => new Date(t2.getTime() + 60000));
		row = await formRow(reference);
		expect(row.attempt_count).toBe(3);
	});

	it("recovers to completed when the geocoder fails then succeeds", async () => {
		let calls = 0;
		const failOnceThenSucceed: Geocoder = {
			lookupPostcode: async () => {
				calls += 1;
				if (calls === 1) return { statusCode: 500 };
				return { statusCode: 200, body: { longitude: 50.05, latitude: -5.05 } };
			},
		};
		const payload = example("person_one.json");
		const reference = payload.application_reference as string;
		await ingest(payload);

		const t0 = new Date("2026-08-09T10:00:00Z");
		await tick({ pool, geocoder: failOnceThenSucceed }, config, () => t0);
		let row = await formRow(reference);
		expect(row.status).toBe("validated");
		expect(row.attempt_count).toBe(1);

		await tick({ pool, geocoder: failOnceThenSucceed }, config, () => new Date(t0.getTime() + 1000));
		row = await formRow(reference);
		expect(row.status).toBe("completed");
		expect(row.completed_at).not.toBeNull();
		expect(row.last_error).toBeNull();
		expect(row.transformed_payload).toMatchObject({ longitude: 50.05, latitude: -5.05 });
	});

	it("parks a transform failure as transform_failed without blocking other forms", async () => {
		const bad: Record<string, unknown> = { ...example("person_one.json"), date_of_birth: "not-a-date" };
		const good = example("person_two.json");
		await ingest(bad);
		await ingest(good);

		await tick({ pool, geocoder: alwaysSucceed }, config);

		const badRow = await formRow(bad.application_reference as string);
		expect(badRow.status).toBe("transform_failed");
		expect(badRow.completed_at).toBeNull();
		expect(badRow.last_error).toMatchObject({ step: "transform" });

		const goodRow = await formRow(good.application_reference as string);
		expect(goodRow.status).toBe("completed");

		const { rows } = await pool.query(
			"SELECT to_status FROM form_events WHERE to_status = 'transform_failed'",
		);
		expect(rows).toHaveLength(1);

		// Permanent park: not retried by the worker.
		await tick({ pool, geocoder: alwaysSucceed }, config);
		expect((await formRow(bad.application_reference as string)).status).toBe("transform_failed");
	});

	it("leaves non-eligible forms untouched", async () => {
		const payload: Record<string, unknown> = { ...example("person_one.json"), email: 42 };
		await ingest(payload);

		await tick({ pool, geocoder: alwaysSucceed }, config);

		const row = await formRow(payload.application_reference as string);
		expect(row.status).toBe("validation_failed");
		expect(row.transformed_payload).toBeNull();
	});
});
