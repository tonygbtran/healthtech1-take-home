import { PoolClient } from "pg";
import { FormStatus } from "./forms";

export const insertFormEvent = async (
	client: PoolClient,
	event: {
		formId: string;
		fromStatus: FormStatus | null;
		toStatus: FormStatus;
		detail?: unknown;
	},
): Promise<void> => {
	await client.query(
		"INSERT INTO form_events (form_id, from_status, to_status, detail) VALUES ($1, $2, $3, $4)",
		[event.formId, event.fromStatus, event.toStatus, event.detail === undefined ? null : JSON.stringify(event.detail)],
	);
};
