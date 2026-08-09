import { Pool, PoolClient } from "pg";
import { hashPayload } from "../forms/hash";
import { validateIngestedForm, ValidationError, ValidationResult } from "../forms/validate";
import { insertFormEvent } from "../repositories/events";
import { applyCorrection, findFormByReferenceForUpdate, insertForm, updateFormStatus } from "../repositories/forms";

export type IngestOutcome =
	| { outcome: "validated"; applicationReference: string }
	| { outcome: "validation_failed"; applicationReference: string; errors: ValidationError[] }
	| { outcome: "duplicate"; applicationReference: string }
	| { outcome: "corrected"; applicationReference: string }
	| { outcome: "correction_discarded"; applicationReference: string };

// Payloads without a usable application_reference are still stored (nothing is
// ever lost) under a synthetic reference derived from the payload hash.
const resolveReference = (payload: Record<string, unknown>, payloadHash: string): string => {
	const reference = payload.application_reference;
	if (typeof reference === "string" && reference.length > 0) return reference;
	return `unknown-${payloadHash.slice(0, 16)}`;
};

// Shared by fresh submissions, corrections and retries: move a form in
// `received` to validated or validation_failed, with the matching audit event.
export const recordValidationResult = async (
	client: PoolClient,
	formId: string,
	applicationReference: string,
	validation: ValidationResult,
): Promise<void> => {
	if (validation.ok) {
		if (validation.strippedFields.length > 0) {
			console.log(
				`[ingest] form=${formId} ref=${applicationReference} stripped unknown fields: ${validation.strippedFields.join(", ")}`,
			);
		}
		await updateFormStatus(client, formId, "validated");
		await insertFormEvent(client, {
			formId,
			fromStatus: "received",
			toStatus: "validated",
			detail: validation.strippedFields.length > 0 ? { strippedFields: validation.strippedFields } : undefined,
		});
		return;
	}

	await updateFormStatus(client, formId, "validation_failed", { validationErrors: validation.errors });
	await insertFormEvent(client, {
		formId,
		fromStatus: "received",
		toStatus: "validation_failed",
		detail: { validationErrors: validation.errors },
	});
};

export const ingestForm = async (pool: Pool, payload: Record<string, unknown>): Promise<IngestOutcome> => {
	const payloadHash = hashPayload(payload);
	const applicationReference = resolveReference(payload, payloadHash);
	const validation = validateIngestedForm(payload);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const existing = await findFormByReferenceForUpdate(client, applicationReference);
		if (existing) {
			if (existing.payload_hash === payloadHash) {
				// Identical resend: idempotent no-op, but leave an audit trace.
				await insertFormEvent(client, {
					formId: existing.id,
					fromStatus: existing.status,
					toStatus: existing.status,
					detail: { event: "duplicate_ignored" },
				});
				await client.query("COMMIT");
				return { outcome: "duplicate", applicationReference };
			}

			if (existing.status === "completed") {
				// FORM-BOT has already seen this form; completed is immutable.
				// Record the attempt so there is evidence the provider sent it.
				await insertFormEvent(client, {
					formId: existing.id,
					fromStatus: "completed",
					toStatus: "completed",
					detail: { event: "correction_discarded" },
				});
				await client.query("COMMIT");
				console.log(
					`[ingest] form=${existing.id} ref=${applicationReference} correction discarded: form already completed`,
				);
				return { outcome: "correction_discarded", applicationReference };
			}

			// Correction before completion: replace the payload and restart the
			// pipeline from received.
			await applyCorrection(client, existing.id, { rawPayload: payload, payloadHash });
			await insertFormEvent(client, {
				formId: existing.id,
				fromStatus: existing.status,
				toStatus: "received",
				detail: { event: "correction_accepted" },
			});
			await recordValidationResult(client, existing.id, applicationReference, validation);
			await client.query("COMMIT");
			return { outcome: "corrected", applicationReference };
		}

		const formId = await insertForm(client, { applicationReference, rawPayload: payload, payloadHash });
		await insertFormEvent(client, { formId, fromStatus: null, toStatus: "received" });
		await recordValidationResult(client, formId, applicationReference, validation);
		await client.query("COMMIT");

		if (validation.ok) return { outcome: "validated", applicationReference };
		return { outcome: "validation_failed", applicationReference, errors: validation.errors };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
};
