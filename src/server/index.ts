import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import fastify from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";

import { pcmSecondsToBytes, pcmToWavBuffer, trimChunksToBytes } from "./audio.js";
import { config } from "./config.js";
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

await mkdir(config.uploadDir, { recursive: true });

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

app.post("/api/import", async (request, reply) => {
  const file = await request.file();

  if (!file) {
    return reply.code(400).send({
      message: "Missing upload file."
    });
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

  return {
    document,
    upload: {
      id: randomUUID(),
      fileName: file.filename,
      path: savedPath
    }
  };
});

app.post<{
  Body: {
    sourceName?: string;
    text?: string;
  };
}>("/api/import/text", async (request, reply) => {
  const text = request.body?.text?.trim();

  if (!text) {
    return reply.code(400).send({
      message: "Text is required."
    });
  }

  return {
    document: importDocumentFromText(request.body.sourceName ?? "Pasted script.txt", text)
  };
});

app.register(async (instance) => {
  instance.get("/ws/transcribe", { websocket: true }, (connection) => {
    const chunks: Buffer[] = [];
    let chunkBytes = 0;
    let lastSpeechAt = 0;
    let lastTranscribedBytes = 0;
    let lastTranscript = "";
    let transcribing = false;

    function resetSession(): void {
      chunks.length = 0;
      chunkBytes = 0;
      lastSpeechAt = 0;
      lastTranscribedBytes = 0;
      lastTranscript = "";
    }

    const interval = setInterval(async () => {
      const now = Date.now();
      const pendingBytes = chunkBytes - lastTranscribedBytes;
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
          connection.socket.send(
            JSON.stringify({
              type: "partial",
              text: normalized,
              receivedAt: new Date().toISOString()
            })
          );
          lastTranscript = normalized;
        }

        lastTranscribedBytes = chunkBytes;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to transcribe audio.";

        connection.socket.send(
          JSON.stringify({
            type: "error",
            message
          })
        );
      } finally {
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true });
        }

        transcribing = false;
      }
    }, config.transcribeIntervalMs);

    connection.socket.on("message", (raw, isBinary) => {
      if (!isBinary) {
        try {
          const message = JSON.parse(raw.toString());

          if (message.type === "reset") {
            resetSession();
          }
        } catch {
          connection.socket.send(
            JSON.stringify({
              type: "error",
              message: "Malformed control message."
            })
          );
        }

        return;
      }

      const chunk = Buffer.from(raw as ArrayBuffer);

      if (!chunk.length) {
        return;
      }

      chunks.push(chunk);
      chunkBytes += chunk.length;
      lastSpeechAt = Date.now();

      const maxBytes = pcmSecondsToBytes(Math.max(config.transcribeWindowSeconds * 3, 30));

      while (chunkBytes > maxBytes && chunks.length > 1) {
        const removed = chunks.shift();

        if (removed) {
          chunkBytes -= removed.length;
        }
      }
    });

    connection.socket.on("close", () => {
      clearInterval(interval);
      resetSession();
    });

    connection.socket.send(
      JSON.stringify({
        type: "ready"
      })
    );
  });
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith("/api/") || request.url.startsWith("/ws/")) {
    return reply.code(404).send({
      message: "Not found."
    });
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
