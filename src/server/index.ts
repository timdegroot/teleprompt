import "dotenv/config";

import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import fastify from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";

import { clearSessionCookie, issueSessionCookie, authPlugin } from "./auth.js";
import { pcmSecondsToBytes, pcmToWavBuffer, trimChunksToBytes } from "./audio.js";
import { config } from "./config.js";
import { migrate } from "./db.js";
import {
  authenticateUser,
  countUsers,
  createProject,
  createScript,
  createUser,
  deleteProject,
  deleteScript,
  findSessionUser,
  getScript,
  listProjects,
  listScriptsByProject,
  listUsers,
  projectExists,
  updateProject,
  updateScript,
  updateUser
} from "./repositories.js";
import { importDocumentFromBuffer, importDocumentFromText } from "./script-parser.js";
import { CommandTranscriber, WhisperApiTranscriber } from "./transcriber.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDir = path.resolve(__dirname, "../client");

const app = fastify({
  logger: true
});

const transcriber = config.whisperApiUrl.trim()
  ? new WhisperApiTranscriber(config.whisperApiUrl, config.whisperApiTimeoutMs)
  : new CommandTranscriber(config.transcribeCommand);

function requireString(value: unknown, message: string): string {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    throw new Error(message);
  }

  return normalized;
}

await migrate();
await mkdir(config.uploadDir, { recursive: true });

await app.register(authPlugin);
await app.register(multipart, {
  limits: {
    fileSize: 30 * 1024 * 1024
  }
});
await app.register(websocket);
await app.register(fastifyStatic, {
  root: clientDir,
  prefix: "/"
});

app.get("/api/health", async () => ({
  ok: true,
  transcriberConfigured: Boolean(config.whisperApiUrl.trim() || config.transcribeCommand.trim()),
  transport: config.whisperApiUrl.trim() ? "http" : "command"
}));

app.get("/api/auth/me", async (request) => {
  const bootstrapRequired = (await countUsers()) === 0;
  const token = request.cookies[config.sessionCookieName];
  const user = token ? await findSessionUser(config.sessionSecret, token) : null;

  return {
    bootstrapRequired,
    user
  };
});

app.post<{
  Body: {
    name?: string;
    email?: string;
    password?: string;
  };
}>("/api/auth/bootstrap", async (request, reply) => {
  if ((await countUsers()) > 0) {
    return reply.code(409).send({ message: "Bootstrap is already complete." });
  }

  try {
    const user = await createUser({
      name: requireString(request.body?.name, "Name is required."),
      email: requireString(request.body?.email, "Email is required."),
      password: requireString(request.body?.password, "Password is required."),
      role: "admin"
    });

    await createProject({
      name: "General",
      description: "Default project",
      createdBy: user.id
    });

    await issueSessionCookie(reply, user.id);

    return {
      user
    };
  } catch (error) {
    return reply.code(400).send({
      message: error instanceof Error ? error.message : "Bootstrap failed."
    });
  }
});

app.post<{
  Body: {
    email?: string;
    password?: string;
  };
}>("/api/auth/login", async (request, reply) => {
  let email = "";
  let password = "";

  try {
    email = requireString(request.body?.email, "Email is required.");
    password = requireString(request.body?.password, "Password is required.");
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : "Invalid login request." });
  }

  const user = await authenticateUser(email, password);

  if (!user) {
    return reply.code(401).send({ message: "Invalid email or password." });
  }

  await issueSessionCookie(reply, user.id);

  return {
    user
  };
});

app.post("/api/auth/logout", { preValidation: app.authenticate }, async (request, reply) => {
  await clearSessionCookie(request, reply);
  return { ok: true };
});

app.get("/api/projects", { preValidation: app.authenticate }, async () => ({
  projects: await listProjects()
}));

app.post<{
  Body: {
    name?: string;
    description?: string;
  };
}>("/api/projects", { preValidation: app.authenticate }, async (request, reply) => {
  try {
    return {
      project: await createProject({
        name: requireString(request.body?.name, "Project name is required."),
        description: String(request.body?.description ?? ""),
        createdBy: request.user!.id
      })
    };
  } catch (error) {
    return reply.code(400).send({
      message: error instanceof Error ? error.message : "Could not create project."
    });
  }
});

app.patch<{
  Params: { projectId: string };
  Body: {
    name?: string;
    description?: string;
  };
}>("/api/projects/:projectId", { preValidation: app.authenticate }, async (request, reply) => {
  let project;

  try {
    project = await updateProject({
      id: request.params.projectId,
      name: requireString(request.body?.name, "Project name is required."),
      description: String(request.body?.description ?? "")
    });
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : "Could not update project." });
  }

  if (!project) {
    return reply.code(404).send({ message: "Project not found." });
  }

  return { project };
});

app.delete<{
  Params: { projectId: string };
}>("/api/projects/:projectId", { preValidation: app.authenticate }, async (request, reply) => {
  const scripts = await listScriptsByProject(request.params.projectId);
  const removed = await deleteProject(request.params.projectId);

  if (!removed) {
    return reply.code(404).send({ message: "Project not found." });
  }

  await Promise.all(
    scripts
      .map((script) => script.originalFilePath)
      .filter((value): value is string => Boolean(value))
      .map((filePath) => unlink(filePath).catch(() => undefined))
  );

  return { ok: true };
});

app.get<{
  Params: { projectId: string };
}>("/api/projects/:projectId/scripts", { preValidation: app.authenticate }, async (request, reply) => {
  if (!(await projectExists(request.params.projectId))) {
    return reply.code(404).send({ message: "Project not found." });
  }

  return {
    scripts: await listScriptsByProject(request.params.projectId)
  };
});

app.post<{
  Params: { projectId: string };
}>("/api/projects/:projectId/scripts/upload", { preValidation: app.authenticate }, async (request, reply) => {
  if (!(await projectExists(request.params.projectId))) {
    return reply.code(404).send({ message: "Project not found." });
  }

  const file = await request.file();

  if (!file) {
    return reply.code(400).send({ message: "Missing upload file." });
  }

  const buffer = await file.toBuffer();
  const savedName = `${Date.now()}-${file.filename}`;
  const savedPath = path.join(config.uploadDir, savedName);

  await writeFile(savedPath, buffer);

  const document = await importDocumentFromBuffer({
    fileName: file.filename,
    mimeType: file.mimetype,
    buffer
  });
  const script = await createScript({
    projectId: request.params.projectId,
    title: document.title,
    sourceName: file.filename,
    sourceKind: "upload",
    document,
    originalFilePath: savedPath,
    importedBy: request.user!.id
  });

  return { script };
});

app.post<{
  Params: { projectId: string };
  Body: {
    sourceName?: string;
    title?: string;
    text?: string;
  };
}>("/api/projects/:projectId/scripts/text", { preValidation: app.authenticate }, async (request, reply) => {
  if (!(await projectExists(request.params.projectId))) {
    return reply.code(404).send({ message: "Project not found." });
  }

  try {
    const sourceName = request.body?.sourceName?.trim() || "Pasted script.md";
    const document = importDocumentFromText(sourceName, requireString(request.body?.text, "Text is required."));
    const script = await createScript({
      projectId: request.params.projectId,
      title: request.body?.title?.trim() || document.title,
      sourceName,
      sourceKind: "paste",
      document,
      importedBy: request.user!.id
    });

    return { script };
  } catch (error) {
    return reply.code(400).send({
      message: error instanceof Error ? error.message : "Could not save script."
    });
  }
});

app.get<{
  Params: { scriptId: string };
}>("/api/scripts/:scriptId", { preValidation: app.authenticate }, async (request, reply) => {
  const script = await getScript(request.params.scriptId);

  if (!script) {
    return reply.code(404).send({ message: "Script not found." });
  }

  return { script };
});

app.patch<{
  Params: { scriptId: string };
  Body: {
    title?: string;
    sourceName?: string;
    projectId?: string;
    text?: string;
  };
}>("/api/scripts/:scriptId", { preValidation: app.authenticate }, async (request, reply) => {
  let projectId = "";

  try {
    projectId = requireString(request.body?.projectId, "Project is required.");
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : "Could not update script." });
  }

  if (!(await projectExists(projectId))) {
    return reply.code(404).send({ message: "Project not found." });
  }

  let script;

  try {
    const sourceName = request.body?.sourceName?.trim() || "Edited script.md";
    const document = importDocumentFromText(sourceName, requireString(request.body?.text, "Text is required."));
    script = await updateScript({
      id: request.params.scriptId,
      projectId,
      title: request.body?.title?.trim() || document.title,
      sourceName,
      document
    });
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : "Could not update script." });
  }

  if (!script) {
    return reply.code(404).send({ message: "Script not found." });
  }

  return { script };
});

app.delete<{
  Params: { scriptId: string };
}>("/api/scripts/:scriptId", { preValidation: app.authenticate }, async (request, reply) => {
  const script = await getScript(request.params.scriptId);

  if (!script) {
    return reply.code(404).send({ message: "Script not found." });
  }

  const removed = await deleteScript(request.params.scriptId);

  if (!removed) {
    return reply.code(404).send({ message: "Script not found." });
  }

  if (script.originalFilePath) {
    await unlink(script.originalFilePath).catch(() => undefined);
  }

  return { ok: true };
});

app.get("/api/admin/users", { preValidation: app.requireAdmin }, async () => ({
  users: await listUsers()
}));

app.post<{
  Body: {
    name?: string;
    email?: string;
    password?: string;
    role?: "admin" | "member";
  };
}>("/api/admin/users", { preValidation: app.requireAdmin }, async (request, reply) => {
  try {
    const user = await createUser({
      name: requireString(request.body?.name, "Name is required."),
      email: requireString(request.body?.email, "Email is required."),
      password: requireString(request.body?.password, "Password is required."),
      role: request.body?.role === "admin" ? "admin" : "member"
    });

    return { user };
  } catch (error) {
    return reply.code(400).send({
      message: error instanceof Error ? error.message : "Could not create user."
    });
  }
});

app.patch<{
  Params: { userId: string };
  Body: {
    name?: string;
    email?: string;
    password?: string;
    role?: "admin" | "member";
  };
}>("/api/admin/users/:userId", { preValidation: app.requireAdmin }, async (request, reply) => {
  let user;

  try {
    user = await updateUser({
      id: request.params.userId,
      name: requireString(request.body?.name, "Name is required."),
      email: requireString(request.body?.email, "Email is required."),
      role: request.body?.role === "admin" ? "admin" : "member",
      password: request.body?.password
    });
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : "Could not update user." });
  }

  if (!user) {
    return reply.code(404).send({ message: "User not found." });
  }

  return { user };
});

app.register(async (instance) => {
  instance.get(
    "/ws/transcribe",
    {
      websocket: true,
      preValidation: instance.authenticate
    },
    (socket) => {
      const chunks: Buffer[] = [];
      let chunkBytes = 0;
      let totalBytes = 0;
      let lastSpeechAt = 0;
      let lastTranscribedTotalBytes = 0;
      let lastTranscript = "";
      let transcribing = false;

      function resetSession(): void {
        chunks.length = 0;
        chunkBytes = 0;
        totalBytes = 0;
        lastSpeechAt = 0;
        lastTranscribedTotalBytes = 0;
        lastTranscript = "";
      }

      const interval = setInterval(async () => {
        const now = Date.now();
        const pendingBytes = totalBytes - lastTranscribedTotalBytes;
        const enoughNewAudio = pendingBytes >= pcmSecondsToBytes(config.transcribeMinChunkSeconds);
        const enoughSilenceElapsed = now - lastSpeechAt >= config.transcribeSilenceMs;
        const shouldFlushTrailingSpeech = enoughSilenceElapsed && pendingBytes > 0;

        if ((!enoughNewAudio && !shouldFlushTrailingSpeech) || transcribing) {
          return;
        }

        const activeChunks = trimChunksToBytes(chunks, pcmSecondsToBytes(config.transcribeWindowSeconds));
        const pcm = Buffer.concat(activeChunks);

        if (!pcm.length) {
          return;
        }

        transcribing = true;
        let tempDir = "";

        try {
          tempDir = await mkdtemp(path.join(tmpdir(), "teleprompt-"));
          const wavPath = path.join(tempDir, "window.wav");

          await writeFile(wavPath, pcmToWavBuffer(pcm));

          const transcript = await transcriber.transcribe(wavPath);
          const normalized = transcript.trim();

          if (normalized && normalized !== lastTranscript) {
            socket.send(
              JSON.stringify({
                type: "partial",
                text: normalized,
                receivedAt: new Date().toISOString()
              })
            );
            lastTranscript = normalized;
          }

          lastTranscribedTotalBytes = totalBytes;
        } catch (error) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : "Failed to transcribe audio."
            })
          );
        } finally {
          if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
          }

          transcribing = false;
        }
      }, config.transcribeIntervalMs);

      socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (!isBinary) {
          try {
            const message = JSON.parse(raw.toString());

            if (message.type === "reset") {
              resetSession();
            }
          } catch {
            socket.send(JSON.stringify({ type: "error", message: "Malformed control message." }));
          }

          return;
        }

        const chunk = Buffer.from(raw as ArrayBuffer);

        if (!chunk.length) {
          return;
        }

        chunks.push(chunk);
        chunkBytes += chunk.length;
        totalBytes += chunk.length;
        lastSpeechAt = Date.now();

        const maxBytes = pcmSecondsToBytes(Math.max(config.transcribeWindowSeconds * 3, 30));

        while (chunkBytes > maxBytes && chunks.length > 1) {
          const removed = chunks.shift();

          if (removed) {
            chunkBytes -= removed.length;
          }
        }
      });

      socket.on("close", () => {
        clearInterval(interval);
        resetSession();
      });

      socket.send(JSON.stringify({ type: "ready" }));
    }
  );
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
    return reply.code(404).send({ message: "Not found." });
  }

  const html = await readFile(path.join(clientDir, "index.html"), "utf8");
  return reply.type("text/html").send(html);
});

try {
  await app.listen({
    port: config.port,
    host: config.host
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
