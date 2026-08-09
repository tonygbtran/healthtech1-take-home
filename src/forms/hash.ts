import { createHash } from "crypto";

const canonicalise = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalise);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, val]) => [key, canonicalise(val)]),
		);
	}
	return value;
};

// SHA-256 of the payload with object keys sorted recursively, so key order
// differences between resends do not produce different hashes.
export const hashPayload = (payload: unknown): string =>
	createHash("sha256").update(JSON.stringify(canonicalise(payload))).digest("hex");
