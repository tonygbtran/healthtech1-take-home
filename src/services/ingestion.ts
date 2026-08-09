import { Pool } from "pg";
import { hashPayload } from "../forms/hash";
import { validateIngestedForm, ValidationError } from "../forms/validate";
import { insertFormEvent } from "../repositories/events";
import { findFormByReference, insertForm, updateFormStatus } from "../repositories/forms";

export type IngestOutcome =
	| { outcome: "validated"; applicationReference: string }
	| { outcome: "validation_failed"; applicationReference: string; errors: ValidationError[] }
	| { outcome: "duplicate"; applicationReference: string };

// Payloads without a usable application_reference are still stored (nothing is
// ever lost) under a synthetic reference derived from the payload hash.
const resolveReference = (payload: Record<string, unknown>, payloadHash: string): string => {
	const reference = payload.application_reference;
	if (typeof reference === "string" && reference.length > 0) return reference;
	return `unknown-${payloadHash.slice(0, 16)}`;
};

export const ingestForm = async (pool: Pool, payload: Record<string, unknown>): Promise<IngestOutcome> => {
	const payloadHash = hashPayload(payload);
	const applicationReference = resolveReference(payload, payloadHash);
	const validation = validateIngestedForm(payload);

	const client = await pool.connect();
	try {
		await client.query("BEGIN");

		const existing = await findFormByReference(client, applicationReference);
		if (existing) {
			// TODO(ticket 04): dedupe/correction semantics — same-hash resends
			// need an audit event, and differing payloads (corrections) must be
			// stored, not dropped as they are here.
			await client.query("COMMIT");
			return { outcome: "duplicate", applicationReference };
		}

		const formId = await insertForm(client, { applicationReference, rawPayload: payload, payloadHash });
		await insertFormEvent(client, { formId, fromStatus: null, toStatus: "received" });

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
			await client.query("COMMIT");
			return { outcome: "validated", applicationReference };
		}

		await updateFormStatus(client, formId, "validation_failed", { validationErrors: validation.errors });
		await insertFormEvent(client, {
			formId,
			fromStatus: "received",
			toStatus: "validation_failed",
			detail: { validationErrors: validation.errors },
		});
		await client.query("COMMIT");
		return { outcome: "validation_failed", applicationReference, errors: validation.errors };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
};
