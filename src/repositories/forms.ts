import { Pool, PoolClient } from "pg";

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

export type EligibleForm = {
	id: string;
	application_reference: string;
	raw_payload: unknown;
	attempt_count: number;
};

// Eligible for the pipeline worker: validated, retry window passed, attempts under cap.
export const findEligibleForms = async (pool: Pool, maxAttempts: number, now: Date): Promise<EligibleForm[]> => {
	const { rows } = await pool.query<EligibleForm>(
		`SELECT id, application_reference, raw_payload, attempt_count
		 FROM forms
		 WHERE status = 'validated'
		   AND (next_retry_at IS NULL OR next_retry_at <= $2)
		   AND attempt_count < $1
		 ORDER BY id`,
		[maxAttempts, now],
	);
	return rows;
};

export const markFailure = async (
	client: PoolClient,
	formId: string,
	failure: { status: FormStatus; attemptCount?: number; nextRetryAt?: Date | null; lastError: unknown },
): Promise<void> => {
	await client.query(
		`UPDATE forms
		 SET status = $2, attempt_count = COALESCE($3, attempt_count), next_retry_at = $4,
		     last_error = $5, updated_at = now()
		 WHERE id = $1`,
		[formId, failure.status, failure.attemptCount ?? null, failure.nextRetryAt ?? null, JSON.stringify(failure.lastError)],
	);
};

export const markCompleted = async (
	client: PoolClient,
	formId: string,
	transformedPayload: unknown,
	completedAt: Date,
): Promise<void> => {
	await client.query(
		`UPDATE forms
		 SET status = 'completed', transformed_payload = $2, completed_at = $3,
		     last_error = NULL, updated_at = now()
		 WHERE id = $1`,
		[formId, JSON.stringify(transformedPayload), completedAt],
	);
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
