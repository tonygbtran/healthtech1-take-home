import { Pool } from "pg";

export const createPool = (databaseUrl: string): Pool => new Pool({ connectionString: databaseUrl });
