import { Pool, PoolClient } from "pg";
import { transformForm, Coordinates } from "../forms/transform";
import { validateIngestedForm } from "../forms/validate";
import { HttpResponse } from "../providers/httpresponse";
import { insertFormEvent } from "../repositories/events";
import { EligibleForm, findEligibleForms, markFailure, markCompleted } from "../repositories/forms";
import { findUnsentEmails, insertOutboxEmail, markEmailFailure, markEmailSent } from "../repositories/outbox";

export type Geocoder = {
	lookupPostcode: (postcode: string) => Promise<HttpResponse<Coordinates>>;
};

export type EmailSender = {
	sendEmail: (email: { to: string; subject: string; body: string }) => Promise<HttpResponse<void>>;
};

export type WorkerDeps = {
	pool: Pool;
	geocoder: Geocoder;
	emailSender: EmailSender;
};

export type WorkerConfig = {
	maxAttempts: number;
	backoffBaseMs: number;
	emailRecipient: string;
};

// Backoff doubles per attempt; the exponent is clamped so an outbox email that
// fails for a long time keeps retrying on a bounded (not runaway) interval.
const MAX_BACKOFF_EXPONENT = 10;

const backoffMs = (baseMs: number, attemptCount: number): number =>
	baseMs * 2 ** Math.min(attemptCount - 1, MAX_BACKOFF_EXPONENT);

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
			nextRetryAt: parked ? null : new Date(now().getTime() + backoffMs(config.backoffBaseMs, attemptCount)),
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
	{ pool, geocoder }: Omit<WorkerDeps, "emailSender">,
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

	let completed = false;
	await inTransaction(pool, async (client) => {
		completed = await markCompleted(client, form.id, form.payload_hash, transformed, now());
		if (completed) {
			await insertFormEvent(client, { formId: form.id, fromStatus: "validated", toStatus: "geocoded" });
			await insertFormEvent(client, { formId: form.id, fromStatus: "geocoded", toStatus: "completed" });
			// Same transaction as the completion: the form cannot complete
			// without its notification row existing, and vice versa.
			await insertOutboxEmail(client, {
				formId: form.id,
				recipient: config.emailRecipient,
				subject: `Form completed: ${form.application_reference}`,
				body: JSON.stringify(transformed, null, 2),
			});
		}
	});
	if (completed) {
		console.log(`[worker] form=${form.id} ref=${form.application_reference} completed`);
	} else {
		// Form was corrected (or completed) while we were processing it; the
		// corrected payload will be picked up on a later tick.
		console.log(`[worker] form=${form.id} ref=${form.application_reference} stale completion skipped`);
	}
};

// Drains unsent outbox emails. Failures back off but never park: notifications
// retry indefinitely, and a flaky provider never affects form processing.
const drainOutbox = async ({ pool, emailSender }: WorkerDeps, config: WorkerConfig, now: () => Date): Promise<void> => {
	const emails = await findUnsentEmails(pool, now());
	for (const email of emails) {
		const attemptCount = email.attempt_count + 1;
		let response;
		try {
			response = await emailSender.sendEmail({ to: email.recipient, subject: email.subject, body: email.body });
		} catch (error) {
			response = { statusCode: 0 };
			console.error(`[worker] outbox=${email.id} send threw`, error);
		}
		if (response.statusCode === 200) {
			await markEmailSent(pool, email.id, attemptCount, now());
			console.log(`[worker] outbox=${email.id} sent to ${email.recipient}`);
		} else {
			const nextRetryAt = new Date(now().getTime() + backoffMs(config.backoffBaseMs, attemptCount));
			await markEmailFailure(pool, email.id, attemptCount, nextRetryAt);
			console.log(`[worker] outbox=${email.id} send failed (attempt ${attemptCount}), retrying at ${nextRetryAt.toISOString()}`);
		}
	}
};

// The single test seam for the pipeline worker: one pass over all eligible
// forms, then one pass over unsent outbox emails. The boot-time poll loop is
// a thin shell around this.
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
	await drainOutbox(deps, config, now);
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
