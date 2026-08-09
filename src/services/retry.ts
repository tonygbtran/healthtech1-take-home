import { Pool, PoolClient } from "pg";
import { validateIngestedForm } from "../forms/validate";
import { insertFormEvent } from "../repositories/events";
import {
	FAILED_STATUSES,
	findFormByReferenceForUpdate,
	findParkedFormsForUpdate,
	FormStatus,
	ParkedForm,
	resetToReceived,
} from "../repositories/forms";
import { recordValidationResult } from "./ingestion";

export type RetryResult =
	| { outcome: "retried"; retried: number }
	| { outcome: "not_found" }
	| { outcome: "not_failed"; status: FormStatus };

// A retry replays the stored raw payload from the top of the pipeline: back to
// received (audited), then through current validation. A form parked before a
// code fix therefore flows validated → worker → completed with no provider
// re-submission; a still-broken payload re-parks with a fresh error.
const retryForm = async (client: PoolClient, form: ParkedForm): Promise<void> => {
	await resetToReceived(client, form.id);
	await insertFormEvent(client, {
		formId: form.id,
		fromStatus: form.status,
		toStatus: "received",
		detail: { event: "retry" },
	});
	await recordValidationResult(client, form.id, form.application_reference, validateIngestedForm(form.raw_payload));
	console.log(`[retry] form=${form.id} ref=${form.application_reference} reset from ${form.status}`);
};

const inTransaction = async <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await work(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
};

export const retryAllFailed = async (pool: Pool): Promise<RetryResult> =>
	inTransaction(pool, async (client) => {
		const parked = await findParkedFormsForUpdate(client);
		for (const form of parked) {
			await retryForm(client, form);
		}
		return { outcome: "retried", retried: parked.length };
	});

export const retryByReference = async (pool: Pool, applicationReference: string): Promise<RetryResult> =>
	inTransaction(pool, async (client) => {
		const form = await findFormByReferenceForUpdate(client, applicationReference);
		if (!form) return { outcome: "not_found" };
		if (!FAILED_STATUSES.includes(form.status)) {
			// Covers completed (never-twice: FORM-BOT must not see it again) and
			// forms still moving through the pipeline.
			return { outcome: "not_failed", status: form.status };
		}
		await retryForm(client, form);
		return { outcome: "retried", retried: 1 };
	});
