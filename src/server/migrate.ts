import "dotenv/config";

import { migrate, pool } from "./db.js";

try {
  await migrate();
  console.log("Database migration completed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
