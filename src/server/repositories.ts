import { randomUUID } from "node:crypto";

import { pool } from "./db.js";
import { hashPassword, hashSessionToken, normalizeEmail, verifyPassword } from "./security.js";
import type { ScriptDocument } from "./types.js";

export type UserRole = "admin" | "member";

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  scriptCount: number;
}

export interface ScriptRecord {
  id: string;
  projectId: string;
  title: string;
  sourceName: string;
  sourceKind: "upload" | "paste";
  plainText: string;
  document: ScriptDocument;
  originalFilePath: string | null;
  importedBy: string;
  createdAt: string;
  updatedAt: string;
}

function mapUser(row: any): UserRecord {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapProject(row: any): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    scriptCount: Number(row.script_count ?? 0)
  };
}

function mapScript(row: any): ScriptRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    sourceName: row.source_name,
    sourceKind: row.source_kind,
    plainText: row.plain_text,
    document: row.document_json as ScriptDocument,
    originalFilePath: row.original_file_path,
    importedBy: row.imported_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function countUsers(): Promise<number> {
  const result = await pool.query<{ count: string }>("select count(*)::text as count from users");
  return Number(result.rows[0]?.count ?? 0);
}

export async function countAdmins(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "select count(*)::text as count from users where role = 'admin'"
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}): Promise<UserRecord> {
  const result = await pool.query(
    `
    insert into users (id, name, email, password_hash, role)
    values ($1, $2, $3, $4, $5)
    returning *
    `,
    [randomUUID(), input.name.trim(), normalizeEmail(input.email), hashPassword(input.password), input.role]
  );

  return mapUser(result.rows[0]);
}

export async function listUsers(): Promise<UserRecord[]> {
  const result = await pool.query("select * from users order by created_at asc");
  return result.rows.map(mapUser);
}

export async function updateUser(input: {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  password?: string;
}): Promise<UserRecord | null> {
  if (input.role !== "admin") {
    const currentRole = await pool.query<{ role: UserRole }>("select role from users where id = $1", [input.id]);

    if (currentRole.rows[0]?.role === "admin" && (await countAdmins()) <= 1) {
      throw new Error("You cannot remove the last admin.");
    }
  }

  const values = [input.id, input.name.trim(), normalizeEmail(input.email), input.role];
  let query = `
    update users
    set name = $2,
        email = $3,
        role = $4,
        updated_at = now()
  `;

  if (input.password?.trim()) {
    values.push(hashPassword(input.password));
    query += `, password_hash = $5 `;
  }

  query += ` where id = $1 returning *`;

  const result = await pool.query(query, values);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserForLogin(email: string): Promise<(UserRecord & { passwordHash: string }) | null> {
  const result = await pool.query("select * from users where email = $1", [normalizeEmail(email)]);
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    ...mapUser(row),
    passwordHash: row.password_hash
  };
}

export async function authenticateUser(email: string, password: string): Promise<UserRecord | null> {
  const record = await findUserForLogin(email);

  if (!record || !verifyPassword(password, record.passwordHash)) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    email: record.email,
    role: record.role,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export async function createSession(args: {
  userId: string;
  token: string;
  secret: string;
  expiresAt: Date;
}): Promise<void> {
  await pool.query(
    `
    insert into sessions (id, user_id, token_hash, expires_at)
    values ($1, $2, $3, $4)
    `,
    [randomUUID(), args.userId, hashSessionToken(args.secret, args.token), args.expiresAt.toISOString()]
  );
}

export async function deleteSession(secret: string, token: string): Promise<void> {
  await pool.query("delete from sessions where token_hash = $1", [hashSessionToken(secret, token)]);
}

export async function findSessionUser(secret: string, token: string): Promise<UserRecord | null> {
  const result = await pool.query(
    `
    select u.*
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = $1
      and s.expires_at > now()
    `,
    [hashSessionToken(secret, token)]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function createProject(input: {
  name: string;
  description: string;
  createdBy: string;
}): Promise<ProjectRecord> {
  const result = await pool.query(
    `
    insert into projects (id, name, description, created_by)
    values ($1, $2, $3, $4)
    returning *, 0::bigint as script_count
    `,
    [randomUUID(), input.name.trim(), input.description.trim(), input.createdBy]
  );

  return mapProject(result.rows[0]);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const result = await pool.query(
    `
    select p.*, count(s.id)::bigint as script_count
    from projects p
    left join scripts s on s.project_id = p.id
    group by p.id
    order by lower(p.name) asc, p.created_at asc
    `
  );

  return result.rows.map(mapProject);
}

export async function updateProject(input: {
  id: string;
  name: string;
  description: string;
}): Promise<ProjectRecord | null> {
  const result = await pool.query(
    `
    update projects
    set name = $2,
        description = $3,
        updated_at = now()
    where id = $1
    returning *, (
      select count(*)::bigint from scripts where project_id = projects.id
    ) as script_count
    `,
    [input.id, input.name.trim(), input.description.trim()]
  );

  return result.rows[0] ? mapProject(result.rows[0]) : null;
}

export async function deleteProject(id: string): Promise<boolean> {
  const result = await pool.query("delete from projects where id = $1", [id]);
  return result.rowCount > 0;
}

export async function createScript(input: {
  projectId: string;
  title: string;
  sourceName: string;
  sourceKind: "upload" | "paste";
  document: ScriptDocument;
  originalFilePath?: string | null;
  importedBy: string;
}): Promise<ScriptRecord> {
  const result = await pool.query(
    `
    insert into scripts (
      id, project_id, title, source_name, source_kind, plain_text, document_json, original_file_path, imported_by
    ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    returning *
    `,
    [
      randomUUID(),
      input.projectId,
      input.title.trim(),
      input.sourceName,
      input.sourceKind,
      input.document.plainText,
      JSON.stringify(input.document),
      input.originalFilePath ?? null,
      input.importedBy
    ]
  );

  return mapScript(result.rows[0]);
}

export async function listScriptsByProject(projectId: string): Promise<ScriptRecord[]> {
  const result = await pool.query(
    "select * from scripts where project_id = $1 order by updated_at desc, created_at desc",
    [projectId]
  );
  return result.rows.map(mapScript);
}

export async function getScript(id: string): Promise<ScriptRecord | null> {
  const result = await pool.query("select * from scripts where id = $1", [id]);
  return result.rows[0] ? mapScript(result.rows[0]) : null;
}

export async function updateScript(input: {
  id: string;
  projectId: string;
  title: string;
  sourceName: string;
  document: ScriptDocument;
}): Promise<ScriptRecord | null> {
  const result = await pool.query(
    `
    update scripts
    set project_id = $2,
        title = $3,
        source_name = $4,
        plain_text = $5,
        document_json = $6::jsonb,
        updated_at = now()
    where id = $1
    returning *
    `,
    [input.id, input.projectId, input.title.trim(), input.sourceName, input.document.plainText, JSON.stringify(input.document)]
  );

  return result.rows[0] ? mapScript(result.rows[0]) : null;
}

export async function deleteScript(id: string): Promise<boolean> {
  const result = await pool.query("delete from scripts where id = $1", [id]);
  return result.rowCount > 0;
}

export async function projectExists(id: string): Promise<boolean> {
  const result = await pool.query("select 1 from projects where id = $1", [id]);
  return Boolean(result.rows[0]);
}
