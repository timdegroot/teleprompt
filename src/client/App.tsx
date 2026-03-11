import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import {
  bootstrapAccount,
  createProject as createProjectRequest,
  createTextScript,
  createUser as createUserRequest,
  fetchProjects,
  fetchScripts,
  fetchSession,
  fetchUsers,
  login,
  logout,
  removeProject,
  removeScript,
  updateProject as updateProjectRequest,
  updateScript as updateScriptRequest,
  updateUser as updateUserRequest,
  uploadScript
} from "./api";
import { findBestMatchingIndex } from "./lib/match";
import type { Project, ScriptDocument, ScriptRecord, TranscriptEvent, User, UserRole } from "./types";

const emptyDocument: ScriptDocument = {
  title: "No script selected",
  sourceName: "Untitled.md",
  importedAt: new Date().toISOString(),
  plainText: "",
  editableText: "",
  blocks: []
};

type ViewMode = "library" | "teleprompter" | "admin";
type ListenStatus = "idle" | "connecting" | "listening" | "error";
type FollowMode = "voice" | "manual";

interface CaptureState {
  reset: () => void;
  stop: () => Promise<void>;
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
      args.onTranscript(JSON.parse(String(event.data)) as TranscriptEvent);
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

function AuthScreen(props: {
  bootstrapRequired: boolean;
  error: string;
  onBootstrap: (event: FormEvent<HTMLFormElement>) => void;
  onLogin: (event: FormEvent<HTMLFormElement>) => void;
  bootstrapForm: { name: string; email: string; password: string };
  setBootstrapForm: (value: { name: string; email: string; password: string }) => void;
  loginForm: { email: string; password: string };
  setLoginForm: (value: { email: string; password: string }) => void;
}) {
  const isBootstrap = props.bootstrapRequired;

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">Teleprompt</p>
        <h1>{isBootstrap ? "Create the first admin account" : "Sign in"}</h1>
        <p className="lede">
          {isBootstrap
            ? "The first account becomes the system administrator and can manage users."
            : "Sign in to access the script library, projects, and teleprompter."}
        </p>

        <form className="stack-form" onSubmit={isBootstrap ? props.onBootstrap : props.onLogin}>
          {isBootstrap ? (
            <input
              placeholder="Name"
              value={props.bootstrapForm.name}
              onChange={(event) =>
                props.setBootstrapForm({
                  ...props.bootstrapForm,
                  name: event.target.value
                })
              }
            />
          ) : null}
          <input
            placeholder="Email"
            type="email"
            value={isBootstrap ? props.bootstrapForm.email : props.loginForm.email}
            onChange={(event) =>
              isBootstrap
                ? props.setBootstrapForm({
                    ...props.bootstrapForm,
                    email: event.target.value
                  })
                : props.setLoginForm({
                    ...props.loginForm,
                    email: event.target.value
                  })
            }
          />
          <input
            placeholder="Password"
            type="password"
            value={isBootstrap ? props.bootstrapForm.password : props.loginForm.password}
            onChange={(event) =>
              isBootstrap
                ? props.setBootstrapForm({
                    ...props.bootstrapForm,
                    password: event.target.value
                  })
                : props.setLoginForm({
                    ...props.loginForm,
                    password: event.target.value
                  })
            }
          />
          <button className="primary-button" type="submit">
            {isBootstrap ? "Create admin" : "Sign in"}
          </button>
        </form>

        {props.error ? <p className="error-copy">{props.error}</p> : null}
      </section>
    </main>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [view, setView] = useState<ViewMode>("library");
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("Select a script and start listening.");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [bootstrapForm, setBootstrapForm] = useState({ name: "", email: "", password: "" });
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [projectDraft, setProjectDraft] = useState({ name: "", description: "" });
  const [editor, setEditor] = useState({ title: "", sourceName: "Untitled.md", text: "" });
  const [userDraft, setUserDraft] = useState({ name: "", email: "", password: "", role: "member" as UserRole });
  const [activeIndex, setActiveIndex] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [matchTranscript, setMatchTranscript] = useState("");
  const [listenStatus, setListenStatus] = useState<ListenStatus>("idle");
  const [followMode, setFollowMode] = useState<FollowMode>("voice");
  const [manualSpeed, setManualSpeed] = useState(0);
  const [fontScale, setFontScale] = useState(1.18);
  const [level, setLevel] = useState(0);
  const captureRef = useRef<CaptureState | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const promptStageRef = useRef<HTMLDivElement | null>(null);
  const manualSpeedRef = useRef(0);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const selectedScript = useMemo(
    () => scripts.find((script) => script.id === selectedScriptId) ?? null,
    [scripts, selectedScriptId]
  );
  const activeDocument = selectedScript?.document ?? emptyDocument;

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    manualSpeedRef.current = manualSpeed;
  }, [manualSpeed]);

  useEffect(() => {
    if (followMode !== "voice") {
      return;
    }

    activeLineRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }, [activeIndex, followMode]);

  useEffect(() => {
    if (followMode !== "voice" || !matchTranscript.trim()) {
      return;
    }

    setActiveIndex((current) =>
      findBestMatchingIndex({
        blocks: activeDocument.blocks,
        transcript: matchTranscript,
        currentIndex: current
      })
    );
  }, [activeDocument.blocks, followMode, matchTranscript]);

  useEffect(() => {
    if (view !== "teleprompter" || followMode !== "manual") {
      return;
    }

    let frameId = 0;
    let previous = performance.now();

    const tick = (now: number): void => {
      const stage = promptStageRef.current;
      const deltaSeconds = (now - previous) / 1000;
      previous = now;

      if (stage && manualSpeedRef.current !== 0) {
        stage.scrollTop += manualSpeedRef.current * deltaSeconds;
      }

      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [followMode, view]);

  useEffect(() => {
    if (view !== "teleprompter" || followMode !== "manual") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;

      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setManualSpeed((speed) => Math.min(220, speed + 18));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setManualSpeed((speed) => Math.max(-120, speed - 18));
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setManualSpeed(0);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setManualSpeed((speed) => (speed === 0 ? 36 : Math.min(220, speed + 18)));
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [followMode, view]);

  useEffect(() => {
    if (!selectedScript) {
      setEditor({
        title: "",
        sourceName: "Untitled.md",
        text: ""
      });
      return;
    }

    setEditor({
      title: selectedScript.title,
      sourceName: selectedScript.sourceName,
      text: selectedScript.document.editableText || selectedScript.document.plainText
    });
    setActiveIndex(0);
    setPartialTranscript("");
    setMatchTranscript("");
    captureRef.current?.reset();
    promptStageRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [selectedScriptId]);

  useEffect(() => {
    return () => {
      captureRef.current?.stop().catch(() => undefined);
    };
  }, []);

  async function loadSession(): Promise<void> {
    try {
      const session = await fetchSession();

      setBootstrapRequired(session.bootstrapRequired);
      setUser(session.user);
      setReady(true);

      if (session.user) {
        await loadData(session.user, undefined);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load the session.");
      setReady(true);
    }
  }

async function loadData(nextUser: User, preferredProjectId?: string, preferredScriptId?: string): Promise<void> {
    const nextProjects = await fetchProjects();
    setProjects(nextProjects);

    const nextProjectId =
      nextProjects.find((project) => project.id === preferredProjectId)?.id || nextProjects[0]?.id || "";
    setSelectedProjectId(nextProjectId);
    const currentProject = nextProjects.find((project) => project.id === nextProjectId) ?? null;

    setProjectDraft({
      name: currentProject?.name ?? "",
      description: currentProject?.description ?? ""
    });

    if (nextProjectId) {
      const nextScripts = await fetchScripts(nextProjectId);
      setScripts(nextScripts);
      setSelectedScriptId(nextScripts.find((script) => script.id === preferredScriptId)?.id || nextScripts[0]?.id || "");
    } else {
      setScripts([]);
      setSelectedScriptId("");
    }

    if (nextUser.role === "admin") {
      setUsers(await fetchUsers());
    } else {
      setUsers([]);
    }
  }

  async function handleBootstrap(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");

    try {
      const response = await bootstrapAccount(bootstrapForm);
      setUser(response.user);
      setBootstrapRequired(false);
      await loadData(response.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Bootstrap failed.");
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");

    try {
      const response = await login(loginForm);
      setUser(response.user);
      await loadData(response.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Sign-in failed.");
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      await captureRef.current?.stop().catch(() => undefined);
      captureRef.current = null;
      await logout();
      setUser(null);
      setProjects([]);
      setScripts([]);
      setUsers([]);
      setSelectedProjectId("");
      setSelectedScriptId("");
      setActiveIndex(0);
      setPartialTranscript("");
      setMatchTranscript("");
      setListenStatus("idle");
      await loadSession();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not sign out.");
    }
  }

  async function refreshProjects(preferredProjectId?: string, preferredScriptId?: string): Promise<void> {
    if (!user) {
      return;
    }

    await loadData(user, preferredProjectId ?? selectedProjectId, preferredScriptId ?? selectedScriptId);
  }

  async function handleProjectCreate(): Promise<void> {
    try {
      const project = await createProjectRequest(projectDraft);
      await refreshProjects(project.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create project.");
    }
  }

  async function handleProjectUpdate(): Promise<void> {
    if (!selectedProject) {
      return;
    }

    try {
      const project = await updateProjectRequest({
        projectId: selectedProject.id,
        name: projectDraft.name || selectedProject.name,
        description: projectDraft.description || selectedProject.description
      });
      setProjectDraft({
        name: project.name,
        description: project.description
      });
      await refreshProjects(project.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not update project.");
    }
  }

  async function handleProjectDelete(): Promise<void> {
    if (!selectedProject) {
      return;
    }

    try {
      await removeProject(selectedProject.id);
      setProjectDraft({ name: "", description: "" });
      await refreshProjects();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not delete project.");
    }
  }

  async function handleProjectSelect(projectId: string): Promise<void> {
    try {
      setSelectedProjectId(projectId);
      const nextScripts = await fetchScripts(projectId);
      setScripts(nextScripts);
      setSelectedScriptId(nextScripts[0]?.id ?? "");
      const project = projects.find((item) => item.id === projectId);

      if (project) {
        setProjectDraft({
          name: project.name,
          description: project.description
        });
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load project scripts.");
    }
  }

  async function handleFileImport(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];

    if (!file || !selectedProjectId) {
      return;
    }

    try {
      const script = await uploadScript(selectedProjectId, file);
      await refreshProjects(selectedProjectId, script.id);
      setStatusMessage(`Imported ${file.name}.`);
      setView("library");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not import file.");
    }

    event.target.value = "";
  }

  async function handleCreateTextScript(): Promise<void> {
    if (!selectedProjectId) {
      return;
    }

    try {
      const script = await createTextScript({
        projectId: selectedProjectId,
        title: editor.title || "Untitled script",
        sourceName: editor.sourceName || "Untitled.md",
        text: editor.text
      });
      await refreshProjects(selectedProjectId, script.id);
      setStatusMessage(`Saved ${script.title}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create script.");
    }
  }

  async function handleSaveScript(): Promise<void> {
    if (!selectedProjectId) {
      return;
    }

    if (!selectedScript) {
      await handleCreateTextScript();
      return;
    }

    try {
      const script = await updateScriptRequest({
        scriptId: selectedScript.id,
        title: editor.title || selectedScript.title,
        sourceName: editor.sourceName || selectedScript.sourceName,
        projectId: selectedProjectId,
        text: editor.text
      });
      await refreshProjects(selectedProjectId, script.id);
      setStatusMessage(`Updated ${script.title}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not update script.");
    }
  }

  async function handleDeleteScript(): Promise<void> {
    if (!selectedScript) {
      return;
    }

    try {
      await removeScript(selectedScript.id);
      setEditor({ title: "", sourceName: "Untitled.md", text: "" });
      await refreshProjects(selectedProjectId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not delete script.");
    }
  }

  async function handleUserCreate(): Promise<void> {
    if (!user || user.role !== "admin") {
      return;
    }

    try {
      await createUserRequest(userDraft);
      setUserDraft({ name: "", email: "", password: "", role: "member" });
      setUsers(await fetchUsers());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create user.");
    }
  }

  async function handleUserUpdate(target: User, password?: string): Promise<void> {
    if (!user || user.role !== "admin") {
      return;
    }

    try {
      await updateUserRequest({
        userId: target.id,
        name: target.name,
        email: target.email,
        role: target.role,
        password
      });
      setUsers(await fetchUsers());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not update user.");
    }
  }

  async function startListening(): Promise<void> {
    if (captureRef.current || !selectedScript || followMode !== "voice") {
      return;
    }

    setListenStatus("connecting");
    setStatusMessage("Connecting to the speech service...");

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
            setMatchTranscript((current) => mergeTranscriptWindow(current, event.text));
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
    } catch (requestError) {
      captureRef.current = null;
      setListenStatus("error");
      setStatusMessage(requestError instanceof Error ? requestError.message : "Could not start listening.");
    }
  }

  async function stopListening(): Promise<void> {
    await captureRef.current?.stop().catch(() => undefined);
    captureRef.current = null;
    setListenStatus("idle");
    setLevel(0);
    setStatusMessage("Listening stopped.");
  }

  function resetPromptPosition(): void {
    setActiveIndex(0);
    setPartialTranscript("");
    setMatchTranscript("");
    captureRef.current?.reset();
    promptStageRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleFollowModeChange(nextMode: FollowMode): Promise<void> {
    setFollowMode(nextMode);
    setError("");

    if (nextMode === "manual") {
      await stopListening();
      setManualSpeed((current) => (current === 0 ? 36 : current));
      setStatusMessage("Manual scroll mode active. Use arrow keys to adjust speed.");
      return;
    }

    setManualSpeed(0);
    setStatusMessage("Voice follow mode active.");
  }

  if (!ready) {
    return <main className="auth-shell">Loading...</main>;
  }

  if (!user) {
    return (
      <AuthScreen
        bootstrapRequired={bootstrapRequired}
        error={error}
        onBootstrap={(event) => {
          void handleBootstrap(event);
        }}
        onLogin={(event) => {
          void handleLogin(event);
        }}
        bootstrapForm={bootstrapForm}
        setBootstrapForm={setBootstrapForm}
        loginForm={loginForm}
        setLoginForm={setLoginForm}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Teleprompt</p>
          <h1>Projects and scripts</h1>
          <p className="lede">Signed in as {user.name}. Organize scripts by project, then run them in prompt mode.</p>
        </div>

        <div className="sidebar-nav">
          <button className={view === "library" ? "nav-chip active" : "nav-chip"} onClick={() => setView("library")}>
            Library
          </button>
          <button
            className={view === "teleprompter" ? "nav-chip active" : "nav-chip"}
            onClick={() => setView("teleprompter")}
          >
            Teleprompter
          </button>
          {user.role === "admin" ? (
            <button className={view === "admin" ? "nav-chip active" : "nav-chip"} onClick={() => setView("admin")}>
              Admin
            </button>
          ) : null}
        </div>

        <section className="panel-card">
          <div className="panel-heading">
            <h2>Projects</h2>
            <button className="secondary-button" onClick={() => setProjectDraft({ name: "", description: "" })}>
              New
            </button>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                className={project.id === selectedProjectId ? "list-item active" : "list-item"}
                onClick={() => void handleProjectSelect(project.id)}
              >
                <strong>{project.name}</strong>
                <span>{project.scriptCount} scripts</span>
              </button>
            ))}
          </div>
          <input
            placeholder="Project name"
            value={projectDraft.name}
            onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })}
          />
          <textarea
            placeholder="Description"
            value={projectDraft.description}
            onChange={(event) => setProjectDraft({ ...projectDraft, description: event.target.value })}
          />
          <div className="button-row">
            <button className="primary-button" onClick={() => void handleProjectCreate()}>
              Create project
            </button>
            {selectedProject ? (
              <>
                <button className="secondary-button" onClick={() => void handleProjectUpdate()}>
                  Update
                </button>
                <button className="danger-button" onClick={() => void handleProjectDelete()}>
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </section>

        <section className="panel-card">
          <div className="panel-heading">
            <h2>Scripts</h2>
            <button
              className="secondary-button"
              onClick={() => {
                setSelectedScriptId("");
                setEditor({ title: "", sourceName: "Untitled.md", text: "" });
              }}
            >
              New
            </button>
          </div>
          <div className="script-list">
            {scripts.map((script) => (
              <button
                key={script.id}
                className={script.id === selectedScriptId ? "list-item active" : "list-item"}
                onClick={() => {
                  setSelectedScriptId(script.id);
                  setView("library");
                }}
              >
                <strong>{script.title}</strong>
                <span>{new Date(script.updatedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel-card">
          <p className="status-copy">{statusMessage}</p>
          <button className="secondary-button" onClick={() => void handleLogout()}>
            Sign out
          </button>
        </section>
      </aside>

      <main className="content">
        {error ? <div className="banner error-copy">{error}</div> : null}

        {view === "library" ? (
          <div className="workspace-grid">
            <section className="panel-card">
              <div className="panel-heading">
                <h2>{selectedScript ? "Edit script" : "Create script"}</h2>
                {selectedScript ? (
                  <button className="secondary-button" onClick={() => setView("teleprompter")}>
                    Open in prompt
                  </button>
                ) : null}
              </div>
              <input
                placeholder="Script title"
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
              />
              <input
                placeholder="Source name"
                value={editor.sourceName}
                onChange={(event) => setEditor({ ...editor, sourceName: event.target.value })}
              />
              <textarea
                className="editor-area"
                placeholder="Paste or edit the script here"
                value={editor.text}
                onChange={(event) => setEditor({ ...editor, text: event.target.value })}
              />
              <div className="button-row">
                <button className="primary-button" onClick={() => void handleSaveScript()}>
                  {selectedScript ? "Save changes" : "Create script"}
                </button>
                {selectedScript ? (
                  <button className="danger-button" onClick={() => void handleDeleteScript()}>
                    Delete script
                  </button>
                ) : null}
              </div>
            </section>

            <section className="panel-card">
              <div className="panel-heading">
                <h2>Import into {selectedProject?.name ?? "project"}</h2>
              </div>
              <input
                type="file"
                accept=".md,.markdown,.txt,.docx,.pdf"
                onChange={(event) => {
                  void handleFileImport(event);
                }}
              />
              <p className="field-hint">Upload files or paste text into the editor and save it directly.</p>
            </section>
          </div>
        ) : null}

        {view === "teleprompter" ? (
          <div className="prompt-layout">
            <header className="prompt-toolbar panel-card">
              <div>
                <p className="eyebrow">Current script</p>
                <h2>{selectedScript?.title ?? "Select a script"}</h2>
                <p className="field-hint">{selectedScript?.sourceName ?? "No script selected"}</p>
              </div>
              <div className="prompt-controls">
                <button
                  className={followMode === "voice" ? "nav-chip active" : "nav-chip"}
                  onClick={() => {
                    void handleFollowModeChange("voice");
                  }}
                >
                  Voice follow
                </button>
                <button
                  className={followMode === "manual" ? "nav-chip active" : "nav-chip"}
                  onClick={() => {
                    void handleFollowModeChange("manual");
                  }}
                >
                  Manual scroll
                </button>
                <span className={`status-pill status-${listenStatus}`}>{listenStatus}</span>
                <span className="meter-value">{Math.round(level * 1000)}</span>
                <button
                  className="primary-button"
                  onClick={() => void startListening()}
                  disabled={!selectedScript || followMode !== "voice"}
                >
                  Start
                </button>
                <button className="secondary-button" onClick={() => void stopListening()}>
                  Stop
                </button>
                <button className="secondary-button" onClick={() => resetPromptPosition()}>
                  Reset
                </button>
              </div>
              <div className="prompt-controls">
                {followMode === "manual" ? (
                  <span className="manual-speed">
                    {manualSpeed === 0 ? "Paused" : `${manualSpeed}px/s`}
                    <small>Up/Down adjust, Left pauses, Right resumes</small>
                  </span>
                ) : (
                  <span className="manual-speed">
                    Voice follow
                    <small>Uses fuzzy matching across recent transcript context</small>
                  </span>
                )}
                <label className="range-label">
                  Prompt size
                  <input
                    type="range"
                    min="0.85"
                    max="1.8"
                    step="0.05"
                    value={fontScale}
                    onChange={(event) => setFontScale(Number(event.target.value))}
                  />
                </label>
              </div>
            </header>

            <div className="transcript-banner panel-card">
              <span>Heard</span>
              <strong>{partialTranscript || "Waiting for speech..."}</strong>
            </div>

            <div
              ref={promptStageRef}
              className="prompt-stage"
              style={{ ["--font-scale" as string]: String(fontScale) }}
            >
              {activeDocument.blocks.length ? (
                activeDocument.blocks.map((block, index) => {
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
                })
              ) : (
                <div className="empty-state">Choose a script from the library first.</div>
              )}
            </div>
          </div>
        ) : null}

        {view === "admin" && user.role === "admin" ? (
          <div className="workspace-grid">
            <section className="panel-card">
              <div className="panel-heading">
                <h2>Create user</h2>
              </div>
              <input
                placeholder="Name"
                value={userDraft.name}
                onChange={(event) => setUserDraft({ ...userDraft, name: event.target.value })}
              />
              <input
                placeholder="Email"
                type="email"
                value={userDraft.email}
                onChange={(event) => setUserDraft({ ...userDraft, email: event.target.value })}
              />
              <input
                placeholder="Password"
                type="password"
                value={userDraft.password}
                onChange={(event) => setUserDraft({ ...userDraft, password: event.target.value })}
              />
              <select
                value={userDraft.role}
                onChange={(event) => setUserDraft({ ...userDraft, role: event.target.value as UserRole })}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button className="primary-button" onClick={() => void handleUserCreate()}>
                Create user
              </button>
            </section>

            <section className="panel-card">
              <div className="panel-heading">
                <h2>User accounts</h2>
              </div>
              <div className="user-list">
                {users.map((entry) => (
                  <AdminUserCard
                    key={entry.id}
                    user={entry}
                    onSave={(next, password) => {
                      void handleUserUpdate(next, password);
                    }}
                  />
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function AdminUserCard(props: {
  user: User;
  onSave: (user: User, password?: string) => void;
}) {
  const [draft, setDraft] = useState(props.user);
  const [password, setPassword] = useState("");

  useEffect(() => {
    setDraft(props.user);
  }, [props.user]);

  return (
    <div className="user-card">
      <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <input
        value={draft.email}
        type="email"
        onChange={(event) => setDraft({ ...draft, email: event.target.value })}
      />
      <select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as UserRole })}>
        <option value="member">Member</option>
        <option value="admin">Admin</option>
      </select>
      <input
        placeholder="Reset password (optional)"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <button
        className="secondary-button"
        onClick={() => {
          props.onSave(draft, password || undefined);
          setPassword("");
        }}
      >
        Save
      </button>
    </div>
  );
}

function mergeTranscriptWindow(current: string, incoming: string): string {
  const next = incoming.trim();

  if (!next) {
    return current;
  }

  if (!current.trim()) {
    return limitWords(next, 80);
  }

  if (next.includes(current)) {
    return limitWords(next, 80);
  }

  if (current.includes(next)) {
    return limitWords(current, 80);
  }

  return limitWords(`${current} ${next}`, 80);
}

function limitWords(value: string, count: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - count)).join(" ");
}
