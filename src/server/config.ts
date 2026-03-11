import path from "node:path";

function readNumber(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: readNumber("PORT", 3000),
  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? "./uploads"),
  whisperApiUrl: process.env.WHISPER_API_URL ?? "",
  whisperApiTimeoutMs: readNumber("WHISPER_API_TIMEOUT_MS", 45_000),
  transcribeCommand: process.env.TRANSCRIBE_COMMAND ?? "",
  transcribeIntervalMs: readNumber("TRANSCRIBE_INTERVAL_MS", 1300),
  transcribeWindowSeconds: readNumber("TRANSCRIBE_WINDOW_SECONDS", 12),
  transcribeMinChunkSeconds: readNumber("TRANSCRIBE_MIN_CHUNK_SECONDS", 2),
  transcribeSilenceMs: readNumber("TRANSCRIBE_SILENCE_MS", 900)
};
