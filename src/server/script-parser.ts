import { parse } from "node-html-parser";
import mammoth from "mammoth";
import pdf from "pdf-parse";

import type { ScriptBlock, ScriptDocument, ScriptBlockKind } from "./types.js";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LIST_RE = /^(\s*[-*+]|\s*\d+\.)\s+(.+)$/;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeBlock(kind: ScriptBlockKind, text: string, index: number, depth?: number): ScriptBlock {
  return {
    id: `${index}-${slug(text || kind || "line") || "line"}`,
    kind,
    text,
    depth
  };
}

function normalizeLine(rawLine: string): string {
  return rawLine
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textToBlocks(text: string): ScriptBlock[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: ScriptBlock[] = [];

  lines.forEach((rawLine, index) => {
    const normalized = normalizeLine(rawLine);

    if (!normalized) {
      blocks.push(makeBlock("blank", "", index));
      return;
    }

    const headingMatch = normalized.match(HEADING_RE);

    if (headingMatch) {
      blocks.push(makeBlock("heading", headingMatch[2].trim(), index, headingMatch[1].length));
      return;
    }

    const listMatch = normalized.match(LIST_RE);

    if (listMatch) {
      blocks.push(makeBlock("list", listMatch[2].trim(), index));
      return;
    }

    blocks.push(makeBlock("paragraph", normalized, index));
  });

  return blocks;
}

function blocksToEditableText(blocks: ScriptBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "blank") {
        return "";
      }

      if (block.kind === "heading") {
        return `${"#".repeat(block.depth ?? 1)} ${block.text}`;
      }

      if (block.kind === "list") {
        return `- ${block.text}`;
      }

      return block.text;
    })
    .join("\n");
}

function htmlToBlocks(html: string): ScriptBlock[] {
  const root = parse(html);
  const blocks: ScriptBlock[] = [];

  function push(kind: ScriptBlockKind, text: string, depth?: number): void {
    const normalized = normalizeLine(text);

    if (!normalized) {
      if (blocks.at(-1)?.kind !== "blank") {
        blocks.push(makeBlock("blank", "", blocks.length));
      }
      return;
    }

    blocks.push(makeBlock(kind, normalized, blocks.length, depth));
  }

  function walk(node: { childNodes: any[]; textContent?: string }): void {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const text = normalizeLine(child.rawText ?? "");

        if (text) {
          push("paragraph", text);
        }

        return;
      }

      if (child.nodeType !== 1) {
        return;
      }

      const element = child as { tagName?: string; childNodes: any[]; textContent: string };
      const tagName = (element.tagName ?? "").toLowerCase();

      if (/^h[1-6]$/.test(tagName)) {
        push("heading", child.textContent, Number(tagName.slice(1)));
        return;
      }

      if (tagName === "p") {
        push("paragraph", child.textContent);
        return;
      }

      if (tagName === "li") {
        push("list", child.textContent);
        return;
      }

      if (tagName === "br") {
        push("blank", "");
        return;
      }

      walk(child as { childNodes: any[]; textContent?: string });
    });
  }

  walk(root);

  return blocks.length ? blocks : textToBlocks(root.textContent);
}

async function extractSourceText(buffer: Buffer, fileName: string, mimeType?: string): Promise<string> {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".docx") || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.convertToHtml({ buffer });
    return JSON.stringify({
      html: result.value
    });
  }

  if (lowerName.endsWith(".pdf") || mimeType === "application/pdf") {
    const result = await pdf(buffer);
    return result.text;
  }

  return buffer.toString("utf8");
}

export async function importDocumentFromBuffer(args: {
  fileName: string;
  mimeType?: string;
  buffer: Buffer;
}): Promise<ScriptDocument> {
  const sourceText = await extractSourceText(args.buffer, args.fileName, args.mimeType);
  const isDocx = args.fileName.toLowerCase().endsWith(".docx");
  const blocks = isDocx ? htmlToBlocks(JSON.parse(sourceText).html) : textToBlocks(sourceText);
  const plainText = blocks.map((block) => block.text).join("\n");

  return {
    title: args.fileName.replace(/\.[^.]+$/, ""),
    sourceName: args.fileName,
    importedAt: new Date().toISOString(),
    plainText,
    editableText: (isDocx ? blocksToEditableText(blocks) : sourceText).replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    blocks
  };
}

export function importDocumentFromText(sourceName: string, text: string): ScriptDocument {
  const blocks = textToBlocks(text);

  return {
    title: sourceName.replace(/\.[^.]+$/, "") || "Untitled script",
    sourceName,
    importedAt: new Date().toISOString(),
    plainText: blocks.map((block) => block.text).join("\n"),
    editableText: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    blocks
  };
}
