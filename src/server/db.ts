import { Pool } from "pg";

import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl
});

const migrations = [
  `
  create table if not exists users (
    id text primary key,
    name text not null,
    email text not null unique,
    password_hash text not null,
    role text not null check (role in ('admin', 'member')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists sessions (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists projects (
    id text primary key,
    name text not null,
    description text not null default '',
    created_by text not null references users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create table if not exists scripts (
    id text primary key,
    project_id text not null references projects(id) on delete cascade,
    title text not null,
    source_name text not null,
    source_kind text not null check (source_kind in ('upload', 'paste')),
    plain_text text not null,
    document_json jsonb not null,
    original_file_path text,
    imported_by text not null references users(id) on delete restrict,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  `,
  `
  create index if not exists idx_scripts_project_id on scripts(project_id);
  `,
  `
  create index if not exists idx_sessions_user_id on sessions(user_id);
  `
];

export async function migrate(): Promise<void> {
  if (!config.databaseUrl.trim()) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const client = await pool.connect();

  try {
    await client.query("begin");

    for (const statement of migrations) {
      await client.query(statement);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
