import { ingestedFormSchema, IngestedForm } from "./schemas/ingested_schema";

export type ValidationError = { path: string; message: string };

export type ValidationResult =
	| { ok: true; data: IngestedForm; strippedFields: string[] }
	| { ok: false; errors: ValidationError[] };

const knownTopLevelKeys = new Set(Object.keys(ingestedFormSchema.shape));
const knownAddressKeys = new Set(Object.keys(ingestedFormSchema.shape.address.shape));

const findStrippedFields = (payload: Record<string, unknown>): string[] => {
	const stripped = Object.keys(payload).filter((key) => !knownTopLevelKeys.has(key));
	const address = payload.address;
	if (typeof address === "object" && address !== null && !Array.isArray(address)) {
		for (const key of Object.keys(address)) {
			if (!knownAddressKeys.has(key)) stripped.push(`address.${key}`);
		}
	}
	return stripped;
};

// Unknown fields are stripped (zod objects strip by default), never rejected;
// callers log them and the raw payload retains them.
export const validateIngestedForm = (payload: unknown): ValidationResult => {
	const parsed = ingestedFormSchema.safeParse(payload);
	if (!parsed.success) {
		return {
			ok: false,
			errors: parsed.error.issues.map((issue) => ({
				path: issue.path.join("."),
				message: issue.message,
			})),
		};
	}
	return {
		ok: true,
		data: parsed.data,
		strippedFields: findStrippedFields(payload as Record<string, unknown>),
	};
};
