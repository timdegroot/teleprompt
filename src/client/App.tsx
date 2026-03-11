import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { findBestMatchingIndex } from "./lib/match";
import type { ImportResponse, ScriptDocument, TranscriptEvent } from "./types";

const defaultText = `# Welcome

Paste or upload a script.
Start listening when you are ready.
The teleprompter will follow along block by block.

## Notes

Blank lines stay visible.
Headings stay separate.
You can click any line to jump there.`;

const defaultDocument: ScriptDocument = {
  title: "Welcome",
  sourceName: "Welcome.md",
  importedAt: new Date().toISOString(),
  plainText: defaultText,
  blocks: defaultText.split("\n").map((line, index) => ({
    id: `default-${index}`,
    kind: line.startsWith("#") ? "heading" : line.trim() ? "paragraph" : "blank",
    text: line.replace(/^#+\s*/, ""),
    depth: line.startsWith("##") ? 2 : line.startsWith("#") ? 1 : undefined
  }))
};

type ListenStatus = "idle" | "connecting" | "listening" | "error";

interface CaptureState {
  reset: () => void;
  stop: () => Promise<void>;
}

async function postTextImport(sourceName: string, text: string): Promise<ScriptDocument> {
  const response = await fetch("/api/import/text", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sourceName,
      text
    })
  });

  if (!response.ok) {
    throw new Error("Failed to import text.");
  }

  const data = (await response.json()) as ImportResponse;
  return data.document;
}

async function uploadFile(file: File): Promise<ScriptDocument> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/import", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error("Failed to import file.");
  }

  const data = (await response.json()) as ImportResponse;
  return data.document;
}

async function startCapture(args: {
  onTranscript: (event: TranscriptEvent) => void;
  onLevel: (level: number) => void;
}): Promise<CaptureState> {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/transcribe`);
  socket.binaryType = "arraybuffer";

  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as TranscriptEvent;
      args.onTranscript(message);
    } catch {
      args.onTranscript({
        type: "error",
        message: "Received an unreadable server response."
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      resolve();
    };
    const onError = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      reject(new Error("Could not connect to the speech websocket."));
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const context = new AudioContext();
  await context.audioWorklet.addModule("/audio-capture.worklet.js");
  const source = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1
  });

  let lastSpokenAt = 0;
  const silenceThreshold = 0.009;
  const speechHangoverMs = 280;

  processor.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    const { pcm, rms } = event.data;
    const now = Date.now();

    args.onLevel(rms);

    if (rms >= silenceThreshold) {
      lastSpokenAt = now;
    }

    if (socket.readyState === WebSocket.OPEN && (rms >= silenceThreshold || now - lastSpokenAt <= speechHangoverMs)) {
      socket.send(pcm);
    }
  };

  source.connect(processor);

  return {
    reset: () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "reset" }));
      }
    },
    stop: async () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "reset" }));
      }

      socket.close();
      processor.port.onmessage = null;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      args.onLevel(0);
    }
  };
}

export default function App() {
  const [document, setDocument] = useState<ScriptDocument>(defaultDocument);
  const [pasteText, setPasteText] = useState(defaultText);
  const [activeIndex, setActiveIndex] = useState(0);
  const [listenStatus, setListenStatus] = useState<ListenStatus>("idle");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [statusMessage, setStatusMessage] = useState("Load a script and start listening.");
  const [fontScale, setFontScale] = useState(1.2);
  const [level, setLevel] = useState(0);
  const captureRef = useRef<CaptureState | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);

  const visibleBlocks = useMemo(() => document.blocks, [document.blocks]);

  useEffect(() => {
    activeLineRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }, [activeIndex]);

  useEffect(() => {
    if (!partialTranscript.trim()) {
      return;
    }

    setActiveIndex((current) =>
      findBestMatchingIndex({
        blocks: document.blocks,
        transcript: partialTranscript,
        currentIndex: current
      })
    );
  }, [document.blocks, partialTranscript]);

  useEffect(() => {
    return () => {
      captureRef.current?.stop().catch(() => undefined);
    };
  }, []);

  async function handleTextImport(): Promise<void> {
    try {
      const nextDocument = await postTextImport("Pasted script.md", pasteText);
      setDocument(nextDocument);
      setActiveIndex(0);
      setPartialTranscript("");
      captureRef.current?.reset();
      setStatusMessage(`Loaded ${nextDocument.blocks.length} lines from pasted text.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not import text.");
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const nextDocument = await uploadFile(file);
      setDocument(nextDocument);
      setActiveIndex(0);
      setPartialTranscript("");
      captureRef.current?.reset();
      setStatusMessage(`Loaded ${file.name}.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not import file.");
    }

    event.target.value = "";
  }

  async function startListening(): Promise<void> {
    if (captureRef.current) {
      return;
    }

    setListenStatus("connecting");
    setStatusMessage("Connecting to the local speech service...");

    try {
      captureRef.current = await startCapture({
        onTranscript: (event) => {
          if (event.type === "ready") {
            setListenStatus("listening");
            setStatusMessage("Listening.");
            return;
          }

          if (event.type === "partial" && event.text) {
            setPartialTranscript(event.text);
            setStatusMessage("Following your speech.");
            return;
          }

          if (event.type === "error") {
            setListenStatus("error");
            setStatusMessage(event.message ?? "Speech service error.");
          }
        },
        onLevel: setLevel
      });
      setListenStatus("listening");
      setStatusMessage("Listening.");
    } catch (error) {
      captureRef.current = null;
      setListenStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "Could not start listening.");
    }
  }

  async function stopListening(): Promise<void> {
    if (!captureRef.current) {
      setListenStatus("idle");
      setLevel(0);
      return;
    }

    await captureRef.current.stop();
    captureRef.current = null;
    setListenStatus("idle");
    setStatusMessage("Listening stopped.");
  }

  async function resetSession(): Promise<void> {
    setActiveIndex(0);
    setPartialTranscript("");
    captureRef.current?.reset();
    setStatusMessage("Teleprompter position reset.");
  }

  return (
    <div className="app-shell">
      <aside className="control-panel">
        <div>
          <p className="eyebrow">Teleprompt</p>
          <h1>Self-hosted voice-follow teleprompter</h1>
          <p className="lede">
            Import a script, start the mic, and let the teleprompter follow your place block by block.
          </p>
        </div>

        <section className="panel-card">
          <label className="field-label" htmlFor="upload">
            Upload script
          </label>
          <input
            id="upload"
            className="file-input"
            type="file"
            accept=".md,.markdown,.txt,.docx,.pdf"
            onChange={(event) => {
              void handleFileChange(event);
            }}
          />
          <p className="field-hint">Supported: Markdown, TXT, DOCX, PDF.</p>
        </section>

        <section className="panel-card">
          <label className="field-label" htmlFor="paste-text">
            Paste text
          </label>
          <textarea
            id="paste-text"
            className="text-area"
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
          />
          <button className="primary-button" onClick={() => void handleTextImport()}>
            Import pasted text
          </button>
        </section>

        <section className="panel-card">
          <div className="status-row">
            <span className={`status-pill status-${listenStatus}`}>{listenStatus}</span>
            <span className="meter-value">{Math.round(level * 1000)}</span>
          </div>
          <p className="status-copy">{statusMessage}</p>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${Math.min(100, level * 900)}%` }} />
          </div>
          <div className="button-row">
            <button className="primary-button" onClick={() => void startListening()}>
              Start listening
            </button>
            <button className="secondary-button" onClick={() => void stopListening()}>
              Stop
            </button>
            <button className="secondary-button" onClick={() => void resetSession()}>
              Reset place
            </button>
          </div>
        </section>

        <section className="panel-card">
          <label className="field-label" htmlFor="font-scale">
            Prompt size
          </label>
          <input
            id="font-scale"
            type="range"
            min="0.85"
            max="1.8"
            step="0.05"
            value={fontScale}
            onChange={(event) => setFontScale(Number(event.target.value))}
          />
          <p className="field-hint">{document.sourceName}</p>
        </section>
      </aside>

      <main className="prompt-panel">
        <header className="prompt-header">
          <div>
            <p className="eyebrow">Current script</p>
            <h2>{document.title}</h2>
          </div>
          <div className="transcript-chip">
            <span>Heard</span>
            <strong>{partialTranscript || "Waiting for speech..."}</strong>
          </div>
        </header>

        <div className="prompt-stage" style={{ ["--font-scale" as string]: String(fontScale) }}>
          {visibleBlocks.map((block, index) => {
            const isActive = index === activeIndex;
            const isPast = index < activeIndex;

            return (
              <div
                key={block.id}
                ref={isActive ? activeLineRef : null}
                className={[
                  "prompt-line",
                  `line-${block.kind}`,
                  isActive ? "is-active" : "",
                  isPast ? "is-past" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setActiveIndex(index)}
              >
                {block.text || <span className="blank-line">&nbsp;</span>}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
