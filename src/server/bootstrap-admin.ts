import "dotenv/config";

import { pool } from "./db.js";
import { countUsers, createProject, createUser } from "./repositories.js";

function readFlag(name: string): string {
  const index = process.argv.findIndex((value) => value === `--${name}`);

  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing --${name}`);
  }

  return process.argv[index + 1];
}

try {
  if ((await countUsers()) > 0) {
    throw new Error("Bootstrap skipped because users already exist.");
  }

  const user = await createUser({
    name: readFlag("name"),
    email: readFlag("email"),
    password: readFlag("password"),
    role: "admin"
  });

  await createProject({
    name: readFlag("project-name"),
    description: "Default project",
    createdBy: user.id
  });

  console.log(`Created admin user ${user.email}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
