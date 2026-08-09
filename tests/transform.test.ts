import { transformForm } from "../src/forms/transform";
import { IngestedForm } from "../src/forms/schemas/ingested_schema";

const base: IngestedForm = {
	session_id: "c8267b77-d796-451e-9948-e82f56412b56",
	application_reference: "GRU-123089-2026",
	name: "John Doe",
	email: "john.doe@example.com",
	gender: "male",
	date_of_birth: "1990-01-01",
	phone_number: "07123456789",
	mobile_number: "07123456789",
	address: {
		address_line_1: "Stratford Village Surgery",
		address_line_2: "50C Romford Road",
		address_line_3: "London",
		postcode: "E15 4BZ",
		country: "United Kingdom",
	},
};

const coordinates = { longitude: 50.05, latitude: -5.05 };

describe("transformForm", () => {
	it("transforms a full form to the agreed schema with coordinates merged", () => {
		expect(transformForm(base, coordinates)).toEqual({
			sessionId: "c8267b77-d796-451e-9948-e82f56412b56",
			applicationReference: "GRU-123089-2026",
			firstName: "John",
			lastName: "Doe",
			email: "john.doe@example.com",
			gender: "male",
			dateOfBirth: new Date("1990-01-01"),
			phoneNumber: "07123456789",
			mobileNumber: "07123456789",
			addressLine1: "Stratford Village Surgery",
			addressLine2: "50C Romford Road",
			addressLine3: "London",
			postcode: "E15 4BZ",
			country: "United Kingdom",
			longitude: 50.05,
			latitude: -5.05,
		});
	});

	it("splits the last whitespace token as lastName, the rest as firstName", () => {
		const result = transformForm({ ...base, name: "Mary Jane van der Berg" }, coordinates);
		expect(result.firstName).toBe("Mary Jane van der");
		expect(result.lastName).toBe("Berg");
	});

	it("keeps a multi-hyphen surname intact", () => {
		const result = transformForm({ ...base, name: "Anna Smith-Jones-Lee" }, coordinates);
		expect(result.firstName).toBe("Anna");
		expect(result.lastName).toBe("Smith-Jones-Lee");
	});

	it("maps a single-token name to firstName with empty lastName", () => {
		const result = transformForm({ ...base, name: "Cher" }, coordinates);
		expect(result.firstName).toBe("Cher");
		expect(result.lastName).toBe("");
	});

	it("collapses extra whitespace when splitting the name", () => {
		const result = transformForm({ ...base, name: "  John   Ronald   Tolkien  " }, coordinates);
		expect(result.firstName).toBe("John Ronald");
		expect(result.lastName).toBe("Tolkien");
	});

	it.each([
		["male", "male"],
		["female", "female"],
		["other", "prefer-not-to-say"],
	] as const)("maps gender %s to %s", (input, expected) => {
		expect(transformForm({ ...base, gender: input }, coordinates).gender).toBe(expected);
	});

	it("parses the date of birth into a Date", () => {
		const result = transformForm({ ...base, date_of_birth: "1985-12-31" }, coordinates);
		expect(result.dateOfBirth).toEqual(new Date("1985-12-31"));
	});

	it("throws on an unparseable date of birth", () => {
		expect(() => transformForm({ ...base, date_of_birth: "not-a-date" }, coordinates)).toThrow(/date_of_birth/);
	});

	it("keeps optional fields undefined when absent", () => {
		const { phone_number: _p, ...rest } = base;
		const { address_line_3: _a, ...addressRest } = base.address;
		const result = transformForm({ ...rest, address: addressRest }, coordinates);
		expect(result.phoneNumber).toBeUndefined();
		expect(result.addressLine3).toBeUndefined();
	});
});
