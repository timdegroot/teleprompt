import type { Project, ScriptRecord, User, UserRole } from "./types";

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    let message = `Request failed with ${response.status}`;

    try {
      const payload = (await response.json()) as { message?: string };
      message = payload.message ?? message;
    } catch {
      // Ignore malformed error payloads.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function fetchSession(): Promise<{ bootstrapRequired: boolean; user: User | null }> {
  return request("/api/auth/me", {
    headers: {}
  });
}

export async function bootstrapAccount(input: {
  name: string;
  email: string;
  password: string;
}): Promise<{ user: User }> {
  return request("/api/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function login(input: { email: string; password: string }): Promise<{ user: User }> {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", {
    method: "POST",
    headers: {}
  });
}

export async function fetchProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", {
    headers: {}
  });
  return data.projects;
}

export async function createProject(input: { name: string; description: string }): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.project;
}

export async function updateProject(input: {
  projectId: string;
  name: string;
  description: string;
}): Promise<Project> {
  const data = await request<{ project: Project }>(`/api/projects/${input.projectId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: input.name,
      description: input.description
    })
  });
  return data.project;
}

export async function removeProject(projectId: string): Promise<void> {
  await request(`/api/projects/${projectId}`, {
    method: "DELETE",
    headers: {}
  });
}

export async function fetchScripts(projectId: string): Promise<ScriptRecord[]> {
  const data = await request<{ scripts: ScriptRecord[] }>(`/api/projects/${projectId}/scripts`, {
    headers: {}
  });
  return data.scripts;
}

export async function uploadScript(projectId: string, file: File): Promise<ScriptRecord> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`/api/projects/${projectId}/scripts/upload`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "Could not upload script.");
  }

  const data = (await response.json()) as { script: ScriptRecord };
  return data.script;
}

export async function createTextScript(input: {
  projectId: string;
  title: string;
  sourceName: string;
  text: string;
}): Promise<ScriptRecord> {
  const data = await request<{ script: ScriptRecord }>(`/api/projects/${input.projectId}/scripts/text`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      sourceName: input.sourceName,
      text: input.text
    })
  });
  return data.script;
}

export async function updateScript(input: {
  scriptId: string;
  title: string;
  sourceName: string;
  projectId: string;
  text: string;
}): Promise<ScriptRecord> {
  const data = await request<{ script: ScriptRecord }>(`/api/scripts/${input.scriptId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
  return data.script;
}

export async function removeScript(scriptId: string): Promise<void> {
  await request(`/api/scripts/${scriptId}`, {
    method: "DELETE",
    headers: {}
  });
}

export async function fetchUsers(): Promise<User[]> {
  const data = await request<{ users: User[] }>("/api/admin/users", {
    headers: {}
  });
  return data.users;
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}): Promise<User> {
  const data = await request<{ user: User }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.user;
}

export async function updateUser(input: {
  userId: string;
  name: string;
  email: string;
  password?: string;
  role: UserRole;
}): Promise<User> {
  const data = await request<{ user: User }>(`/api/admin/users/${input.userId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
  return data.user;
}
