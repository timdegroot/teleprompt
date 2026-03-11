import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cleanTranscript(output: string): string {
  return output
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "");
}

export class CommandTranscriber {
  constructor(private readonly commandTemplate: string) {}

  async transcribe(audioPath: string): Promise<string> {
    if (!this.commandTemplate.trim()) {
      throw new Error(
        "TRANSCRIBE_COMMAND is not configured. Point it at a local transcription command such as whisper.cpp."
      );
    }

    const command = this.commandTemplate.replaceAll("{audioPath}", shellQuote(audioPath));
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 20 * 1024 * 1024,
      shell: "/bin/sh"
    });
    const combined = stdout.trim() || stderr.trim();

    return cleanTranscript(combined);
  }
}

export class WhisperApiTranscriber {
  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs: number
  ) {}

  async transcribe(audioPath: string): Promise<string> {
    if (!this.endpoint.trim()) {
      throw new Error("WHISPER_API_URL is not configured.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const audioBuffer = await readFile(audioPath);
      const form = new FormData();

      form.set("file", new Blob([audioBuffer], { type: "audio/wav" }), "window.wav");
      form.set("response_format", "json");
      form.set("temperature", "0.0");

      const response = await fetch(this.endpoint, {
        method: "POST",
        body: form,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Whisper API request failed with ${response.status}.`);
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        const payload = (await response.json()) as { text?: string };
        return cleanTranscript(payload.text ?? "");
      }

      return cleanTranscript(await response.text());
    } finally {
      clearTimeout(timeout);
    }
  }
}
