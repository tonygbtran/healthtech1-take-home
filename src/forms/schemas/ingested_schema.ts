import { z } from "zod";

export const ingestedFormSchema = z.object({
	session_id: z.string().min(1),
	application_reference: z.string().min(1),
	name: z.string().min(1),
	email: z.string().min(1),
	gender: z.enum(["male", "female", "other"]),
	date_of_birth: z.string().min(1),
	phone_number: z.string().optional(),
	mobile_number: z.string().min(1),
	address: z.object({
		address_line_1: z.string().min(1),
		address_line_2: z.string().min(1),
		address_line_3: z.string().optional(),
		postcode: z.string().min(1),
		country: z.string().min(1),
	}),
});

export type IngestedForm = z.infer<typeof ingestedFormSchema>;
