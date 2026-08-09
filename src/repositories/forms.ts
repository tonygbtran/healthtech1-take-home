import { PoolClient } from "pg";

export type FormStatus =
	| "received"
	| "validated"
	| "geocoded"
	| "completed"
	| "validation_failed"
	| "geocode_failed"
	| "transform_failed";

export type FormRow = {
	id: string;
	application_reference: string;
	payload_hash: string;
	status: FormStatus;
};

export const findFormByReference = async (
	client: PoolClient,
	applicationReference: string,
): Promise<FormRow | undefined> => {
	const { rows } = await client.query<FormRow>(
		"SELECT id, application_reference, payload_hash, status FROM forms WHERE application_reference = $1",
		[applicationReference],
	);
	return rows[0];
};

export const insertForm = async (
	client: PoolClient,
	form: { applicationReference: string; rawPayload: unknown; payloadHash: string },
): Promise<string> => {
	const { rows } = await client.query<{ id: string }>(
		"INSERT INTO forms (application_reference, raw_payload, payload_hash) VALUES ($1, $2, $3) RETURNING id",
		[form.applicationReference, JSON.stringify(form.rawPayload), form.payloadHash],
	);
	return rows[0].id;
};

export const updateFormStatus = async (
	client: PoolClient,
	formId: string,
	status: FormStatus,
	lastError: unknown = null,
): Promise<void> => {
	await client.query(
		"UPDATE forms SET status = $2, last_error = $3, updated_at = now() WHERE id = $1",
		[formId, status, lastError === null ? null : JSON.stringify(lastError)],
	);
};
