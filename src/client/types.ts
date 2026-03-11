export type ScriptBlockKind = "heading" | "paragraph" | "list" | "blank";
export type UserRole = "admin" | "member";

export interface ScriptBlock {
  id: string;
  kind: ScriptBlockKind;
  text: string;
  depth?: number;
}

export interface ScriptDocument {
  title: string;
  sourceName: string;
  importedAt: string;
  plainText: string;
  editableText: string;
  blocks: ScriptBlock[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
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

export interface TranscriptEvent {
  type: "ready" | "partial" | "error";
  text?: string;
  message?: string;
  receivedAt?: string;
}
