import { readFileSync } from "fs";
import { join } from "path";

export const example = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(__dirname, "../../src/forms/examples", name), "utf-8"));
