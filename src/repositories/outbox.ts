import { Pool, PoolClient } from "pg";

export const insertOutboxEmail = async (
	client: PoolClient,
	email: { formId: string; recipient: string; subject: string; body: string },
): Promise<void> => {
	await client.query(
		"INSERT INTO outbox_emails (form_id, recipient, subject, body) VALUES ($1, $2, $3, $4)",
		[email.formId, email.recipient, email.subject, email.body],
	);
};

export type UnsentEmail = {
	id: string;
	recipient: string;
	subject: string;
	body: string;
	attempt_count: number;
};

// Unsent and due for (re)delivery. Deliberately no attempt cap: notifications
// retry indefinitely (at-least-once).
export const findUnsentEmails = async (pool: Pool, now: Date): Promise<UnsentEmail[]> => {
	const { rows } = await pool.query<UnsentEmail>(
		`SELECT id, recipient, subject, body, attempt_count
		 FROM outbox_emails
		 WHERE sent_at IS NULL
		   AND (next_retry_at IS NULL OR next_retry_at <= $1)
		 ORDER BY id`,
		[now],
	);
	return rows;
};

export const markEmailSent = async (pool: Pool, emailId: string, attemptCount: number, sentAt: Date): Promise<void> => {
	await pool.query(
		"UPDATE outbox_emails SET sent_at = $3, attempt_count = $2, next_retry_at = NULL WHERE id = $1",
		[emailId, attemptCount, sentAt],
	);
};

export const markEmailFailure = async (
	pool: Pool,
	emailId: string,
	attemptCount: number,
	nextRetryAt: Date,
): Promise<void> => {
	await pool.query(
		"UPDATE outbox_emails SET attempt_count = $2, next_retry_at = $3 WHERE id = $1",
		[emailId, attemptCount, nextRetryAt],
	);
};
