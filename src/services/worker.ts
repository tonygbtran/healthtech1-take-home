import { Pool, PoolClient } from "pg";
import { transformForm, Coordinates } from "../forms/transform";
import { validateIngestedForm } from "../forms/validate";
import { HttpResponse } from "../providers/httpresponse";
import { insertFormEvent } from "../repositories/events";
import { EligibleForm, findEligibleForms, markFailure, markCompleted } from "../repositories/forms";

export type Geocoder = {
	lookupPostcode: (postcode: string) => Promise<HttpResponse<Coordinates>>;
};

export type WorkerDeps = {
	pool: Pool;
	geocoder: Geocoder;
};

export type WorkerConfig = {
	maxAttempts: number;
	backoffBaseMs: number;
};

const inTransaction = async (pool: Pool, work: (client: PoolClient) => Promise<void>): Promise<void> => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await work(client);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
};

// Permanent park: transform (or unexpected) failures wait for /retry, never the worker.
const parkTransformFailure = async (pool: Pool, form: EligibleForm, error: unknown): Promise<void> => {
	const message = error instanceof Error ? error.message : String(error);
	await inTransaction(pool, async (client) => {
		await markFailure(client, form.id, {
			status: "transform_failed",
			lastError: { step: "transform", message },
		});
		await insertFormEvent(client, {
			formId: form.id,
			fromStatus: "validated",
			toStatus: "transform_failed",
			detail: { message },
		});
	});
	console.log(`[worker] form=${form.id} ref=${form.application_reference} parked as transform_failed: ${message}`);
};

const handleGeocodeFailure = async (
	pool: Pool,
	config: WorkerConfig,
	form: EligibleForm,
	statusCode: number,
	now: () => Date,
): Promise<void> => {
	const attemptCount = form.attempt_count + 1;
	const parked = attemptCount >= config.maxAttempts;
	await inTransaction(pool, async (client) => {
		await markFailure(client, form.id, {
			status: parked ? "geocode_failed" : "validated",
			attemptCount,
			nextRetryAt: parked ? null : new Date(now().getTime() + config.backoffBaseMs * 2 ** (attemptCount - 1)),
			lastError: { step: "geocode", statusCode },
		});
		if (parked) {
			await insertFormEvent(client, {
				formId: form.id,
				fromStatus: "validated",
				toStatus: "geocode_failed",
				detail: { attemptCount, statusCode },
			});
		}
	});
	console.log(
		`[worker] form=${form.id} ref=${form.application_reference} geocode failed (attempt ${attemptCount}/${config.maxAttempts})${parked ? ", parked as geocode_failed" : ""}`,
	);
};

const processForm = async (
	{ pool, geocoder }: WorkerDeps,
	config: WorkerConfig,
	form: EligibleForm,
	now: () => Date,
): Promise<void> => {
	const validation = validateIngestedForm(form.raw_payload);
	if (!validation.ok) {
		// Should be unreachable: only validated forms are eligible. Park rather than loop.
		await parkTransformFailure(pool, form, new Error("eligible form no longer passes validation"));
		return;
	}

	const geocodeResponse = await geocoder.lookupPostcode(validation.data.address.postcode);
	if (geocodeResponse.statusCode !== 200 || geocodeResponse.body === undefined) {
		await handleGeocodeFailure(pool, config, form, geocodeResponse.statusCode, now);
		return;
	}

	let transformed;
	try {
		transformed = transformForm(validation.data, geocodeResponse.body);
	} catch (error) {
		await parkTransformFailure(pool, form, error);
		return;
	}

	await inTransaction(pool, async (client) => {
		await insertFormEvent(client, { formId: form.id, fromStatus: "validated", toStatus: "geocoded" });
		await markCompleted(client, form.id, transformed, now());
		await insertFormEvent(client, { formId: form.id, fromStatus: "geocoded", toStatus: "completed" });
	});
	console.log(`[worker] form=${form.id} ref=${form.application_reference} completed`);
};

// The single test seam for the pipeline worker: one pass over all eligible
// forms. The boot-time poll loop is a thin shell around this.
export const tick = async (deps: WorkerDeps, config: WorkerConfig, now: () => Date = () => new Date()): Promise<void> => {
	const forms = await findEligibleForms(deps.pool, config.maxAttempts, now());
	for (const form of forms) {
		try {
			await processForm(deps, config, form, now);
		} catch (error) {
			// One form's unexpected error must never block the rest of the batch.
			console.error(`[worker] form=${form.id} ref=${form.application_reference} tick error`, error);
		}
	}
};

// Thin shell around tick(): serial ticks (never overlapping), errors logged
// so a bad pass never kills the loop. Returns a stop function.
export const startPollLoop = (runTick: () => Promise<void>, intervalMs: number): (() => void) => {
	let stopped = false;
	let timer: NodeJS.Timeout;
	const schedule = () => {
		timer = setTimeout(async () => {
			try {
				await runTick();
			} catch (error) {
				console.error("[worker] tick failed", error);
			}
			if (!stopped) schedule();
		}, intervalMs);
	};
	schedule();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
};
