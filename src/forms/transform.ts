import { IngestedForm } from "./schemas/ingested_schema";
import { TransformedFormSchema } from "./schemas/transformed_schema";

export type Coordinates = { longitude: number; latitude: number };

// Documented assumption (flagged to provider): the last whitespace token is the
// surname, everything before it the first name; a single token is all firstName.
const splitName = (name: string): { firstName: string; lastName: string } => {
	const tokens = name.trim().split(/\s+/);
	if (tokens.length === 1) return { firstName: tokens[0], lastName: "" };
	return { firstName: tokens.slice(0, -1).join(" "), lastName: tokens[tokens.length - 1] };
};

// Documented assumption (flagged to provider): "other" maps to "prefer-not-to-say".
const mapGender = (gender: IngestedForm["gender"]): TransformedFormSchema["gender"] =>
	gender === "other" ? "prefer-not-to-say" : gender;

const parseDateOfBirth = (value: string): Date => {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`Unparseable date_of_birth: "${value}"`);
	return parsed;
};

export const transformForm = (form: IngestedForm, coordinates: Coordinates): TransformedFormSchema => {
	const { firstName, lastName } = splitName(form.name);
	return {
		sessionId: form.session_id,
		applicationReference: form.application_reference,
		firstName,
		lastName,
		email: form.email,
		gender: mapGender(form.gender),
		dateOfBirth: parseDateOfBirth(form.date_of_birth),
		phoneNumber: form.phone_number,
		mobileNumber: form.mobile_number,
		addressLine1: form.address.address_line_1,
		addressLine2: form.address.address_line_2,
		addressLine3: form.address.address_line_3,
		postcode: form.address.postcode,
		country: form.address.country,
		longitude: coordinates.longitude,
		latitude: coordinates.latitude,
	};
};
