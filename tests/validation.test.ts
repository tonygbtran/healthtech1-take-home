import { validateIngestedForm } from "../src/forms/validate";
import { example } from "./helpers/examples";

const validForm = () => example("person_one.json");

describe("validateIngestedForm", () => {
	it.each(["person_one.json", "person_two.json", "person_three.json"])(
		"accepts the provided example form %s",
		(file) => {
			const result = validateIngestedForm(example(file));
			expect(result.ok).toBe(true);
		},
	);

	it("rejects a payload missing required fields", () => {
		const { name, ...rest } = validForm();
		const result = validateIngestedForm(rest);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(JSON.stringify(result.errors)).toContain("name");
		}
	});

	it("rejects wrong types", () => {
		const result = validateIngestedForm({ ...validForm(), email: 42 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(JSON.stringify(result.errors)).toContain("email");
		}
	});

	it("rejects an unknown gender value", () => {
		const result = validateIngestedForm({ ...validForm(), gender: "unknown" });
		expect(result.ok).toBe(false);
	});

	it("strips unknown fields and reports them", () => {
		const payload = {
			...validForm(),
			nhs_number: "123",
			address: { ...(validForm().address as Record<string, unknown>), what3words: "a.b.c" },
		};
		const result = validateIngestedForm(payload);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data).not.toHaveProperty("nhs_number");
			expect(result.data.address).not.toHaveProperty("what3words");
			expect(result.strippedFields.sort()).toEqual(["address.what3words", "nhs_number"]);
		}
	});

	it("accepts forms without the optional phone_number and address_line_3", () => {
		const { phone_number, ...rest } = validForm();
		const address = { ...(rest.address as Record<string, unknown>) };
		delete address.address_line_3;
		const result = validateIngestedForm({ ...rest, address });
		expect(result.ok).toBe(true);
	});
});
