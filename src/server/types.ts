export type ScriptBlockKind = "heading" | "paragraph" | "list" | "blank";

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

export interface ImportResult {
  document: ScriptDocument;
}
