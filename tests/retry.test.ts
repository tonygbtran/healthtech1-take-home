import request from "supertest";
import { Pool } from "pg";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { Geocoder } from "../src/services/worker";
import { createTestPool, truncateAll } from "./helpers/db";
import { example } from "./helpers/examples";
import { alwaysSucceedGeocoder as alwaysSucceed, tickForms as tick } from "./helpers/worker";

const config = { maxAttempts: 3, backoffBaseMs: 1000 };

const alwaysFailGeocoder: Geocoder = {
	lookupPostcode: async () => ({ statusCode: 500 }),
};

describe("/forms/failed and /retry", () => {
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

	const ingest = async (payload: Record<string, unknown>) => {
		const response = await request(app()).post("/ingest").send(payload);
		expect(response.status).toBe(202);
	};

	const formRow = async (reference: string) => {
		const { rows } = await pool.query(
			"SELECT id, status, attempt_count, next_retry_at, completed_at FROM forms WHERE application_reference = $1",
			[reference],
		);
		return rows[0];
	};

	// Exhaust the attempt cap against a failing geocoder so the form parks as
	// geocode_failed. next_retry_at is pushed into the past between ticks so
	// backoff never blocks eligibility.
	const parkAsGeocodeFailed = async (reference: string) => {
		for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
			await pool.query("UPDATE forms SET next_retry_at = now() - interval '1 hour' WHERE application_reference = $1", [
				reference,
			]);
			await tick({ pool, geocoder: alwaysFailGeocoder }, config);
		}
		expect((await formRow(reference)).status).toBe("geocode_failed");
	};

	const invalidPayload = (reference: string): Record<string, unknown> => {
		const payload = example("person_one.json");
		payload.application_reference = reference;
		delete payload.email;
		return payload;
	};

	describe("GET /forms/failed", () => {
		it("lists parked forms with reference, status, attempts and last error; excludes healthy and completed forms", async () => {
			// One of each: validation-parked, geocode-parked, completed, still-processing.
			await ingest(invalidPayload("FAIL-VALIDATION"));

			const geocodeFail = example("person_two.json");
			geocodeFail.application_reference = "FAIL-GEOCODE";
			await ingest(geocodeFail);
			await parkAsGeocodeFailed("FAIL-GEOCODE");

			const completed = example("person_one.json");
			completed.application_reference = "COMPLETED-1";
			await ingest(completed);
			await tick({ pool, geocoder: alwaysSucceed }, config);
			expect((await formRow("COMPLETED-1")).status).toBe("completed");

			const pending = example("person_three.json");
			pending.application_reference = "PENDING-1";
			await ingest(pending);

			const response = await request(app()).get("/forms/failed");
			expect(response.status).toBe(200);

			const byReference = Object.fromEntries(
				response.body.forms.map((form: { applicationReference: string }) => [form.applicationReference, form]),
			);
			expect(Object.keys(byReference).sort()).toEqual(["FAIL-GEOCODE", "FAIL-VALIDATION"]);
			expect(byReference["FAIL-VALIDATION"]).toMatchObject({
				status: "validation_failed",
				attemptCount: 0,
			});
			expect(byReference["FAIL-VALIDATION"].lastError).toBeTruthy();
			expect(byReference["FAIL-GEOCODE"]).toMatchObject({
				status: "geocode_failed",
				attemptCount: config.maxAttempts,
				lastError: { step: "geocode", statusCode: 500 },
			});
		});

		it("returns an empty list when nothing is parked", async () => {
			const response = await request(app()).get("/forms/failed");
			expect(response.status).toBe(200);
			expect(response.body.forms).toEqual([]);
		});
	});

	describe("POST /retry", () => {
		it("a capped-out geocode_failed form retried against a now-working geocoder completes", async () => {
			const payload = example("person_one.json");
			payload.application_reference = "GEO-RECOVER";
			await ingest(payload);
			await parkAsGeocodeFailed("GEO-RECOVER");

			const response = await request(app()).post("/retry").send({});
			expect(response.status).toBe(200);
			expect(response.body.retried).toBe(1);

			const reset = await formRow("GEO-RECOVER");
			expect(reset.status).toBe("validated");
			expect(reset.attempt_count).toBe(0);
			expect(reset.next_retry_at).toBeNull();

			await tick({ pool, geocoder: alwaysSucceed }, config);
			expect((await formRow("GEO-RECOVER")).status).toBe("completed");
		});

		it("a validation_failed form whose payload passes current validation flows to completed (post-code-fix replay)", async () => {
			// Simulate "the validator was buggy when this arrived, and the code
			// fix has since shipped": a payload that today's validator accepts,
			// parked as validation_failed.
			const payload = example("person_two.json");
			payload.application_reference = "VAL-REPLAY";
			await ingest(payload);
			await pool.query(
				`UPDATE forms SET status = 'validation_failed', last_error = '{"validationErrors": []}' WHERE application_reference = $1`,
				["VAL-REPLAY"],
			);

			await request(app()).post("/retry").send({});

			expect((await formRow("VAL-REPLAY")).status).toBe("validated");
			await tick({ pool, geocoder: alwaysSucceed }, config);
			expect((await formRow("VAL-REPLAY")).status).toBe("completed");
		});

		it("a still-invalid payload re-parks as validation_failed on retry", async () => {
			await ingest(invalidPayload("STILL-BAD"));

			const response = await request(app()).post("/retry").send({});
			expect(response.status).toBe(200);
			expect(response.body.retried).toBe(1);
			expect((await formRow("STILL-BAD")).status).toBe("validation_failed");
		});

		it("retry-all resets every parked form and leaves completed forms untouched", async () => {
			await ingest(invalidPayload("BAD-1"));
			await ingest(invalidPayload("BAD-2"));

			const completed = example("person_one.json");
			completed.application_reference = "DONE-1";
			await ingest(completed);
			await tick({ pool, geocoder: alwaysSucceed }, config);

			const response = await request(app()).post("/retry").send({});
			expect(response.status).toBe(200);
			expect(response.body.retried).toBe(2);
			expect((await formRow("DONE-1")).status).toBe("completed");
		});

		it("retries a single form by application reference", async () => {
			await ingest(invalidPayload("ONLY-THIS"));

			const other = example("person_two.json");
			other.application_reference = "NOT-THIS";
			await ingest(other);
			await parkAsGeocodeFailed("NOT-THIS");

			const response = await request(app()).post("/retry").send({ applicationReference: "ONLY-THIS" });
			expect(response.status).toBe(200);
			expect(response.body.retried).toBe(1);

			// The targeted form was re-validated; the other stays parked.
			expect((await formRow("ONLY-THIS")).status).toBe("validation_failed");
			expect((await formRow("NOT-THIS")).status).toBe("geocode_failed");
		});

		it("rejects an empty application reference rather than retrying everything", async () => {
			await ingest(invalidPayload("PARKED-1"));

			const response = await request(app()).post("/retry").send({ applicationReference: "" });
			expect(response.status).toBe(400);
			expect((await formRow("PARKED-1")).status).toBe("validation_failed");
		});

		it("returns 404 for an unknown application reference", async () => {
			const response = await request(app()).post("/retry").send({ applicationReference: "NO-SUCH-FORM" });
			expect(response.status).toBe(404);
		});

		it("refuses to retry a completed form (never-twice holds)", async () => {
			const payload = example("person_one.json");
			payload.application_reference = "DONE-2";
			await ingest(payload);
			await tick({ pool, geocoder: alwaysSucceed }, config);
			expect((await formRow("DONE-2")).status).toBe("completed");

			const response = await request(app()).post("/retry").send({ applicationReference: "DONE-2" });
			expect(response.status).toBe(409);
			expect((await formRow("DONE-2")).status).toBe("completed");
		});

		it("refuses to retry a form that is not parked", async () => {
			const payload = example("person_three.json");
			payload.application_reference = "IN-FLIGHT";
			await ingest(payload);

			const response = await request(app()).post("/retry").send({ applicationReference: "IN-FLIGHT" });
			expect(response.status).toBe(409);
		});

		it("writes audit events for the retry transition", async () => {
			const payload = example("person_one.json");
			payload.application_reference = "AUDITED";
			await ingest(payload);
			await parkAsGeocodeFailed("AUDITED");

			await request(app()).post("/retry").send({ applicationReference: "AUDITED" });

			const { rows } = await pool.query(
				`SELECT from_status, to_status, detail FROM form_events
				 WHERE form_id = (SELECT id FROM forms WHERE application_reference = $1)
				 ORDER BY id`,
				["AUDITED"],
			);
			const retryEvent = rows.find((row) => row.detail?.event === "retry");
			expect(retryEvent).toMatchObject({ from_status: "geocode_failed", to_status: "received" });
			// The re-validation after the retry is audited too.
			expect(rows[rows.length - 1]).toMatchObject({ from_status: "received", to_status: "validated" });
		});
	});
});
