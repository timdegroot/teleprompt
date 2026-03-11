import type { ScriptBlock } from "../types";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

function orderedCoverage(candidateTokens: string[], transcriptTokens: string[]): number {
  if (!candidateTokens.length || !transcriptTokens.length) {
    return 0;
  }

  let matches = 0;
  let cursor = 0;

  for (const token of candidateTokens) {
    const foundAt = transcriptTokens.indexOf(token, cursor);

    if (foundAt >= 0) {
      matches += 1;
      cursor = foundAt + 1;
    }
  }

  return matches / candidateTokens.length;
}

function tailWords(value: string, count: number): string {
  const words = tokenize(value);
  return words.slice(Math.max(0, words.length - count)).join(" ");
}

export function findBestMatchingIndex(args: {
  blocks: ScriptBlock[];
  transcript: string;
  currentIndex: number;
}): number {
  const transcriptTail = tailWords(args.transcript, 28);
  const transcriptTokens = tokenize(transcriptTail);

  if (!transcriptTokens.length) {
    return args.currentIndex;
  }

  let bestIndex = args.currentIndex;
  let bestScore = 0;
  const start = Math.max(0, args.currentIndex - 2);
  const end = Math.min(args.blocks.length - 1, args.currentIndex + 8);

  for (let index = start; index <= end; index += 1) {
    const current = args.blocks[index];
    const next = args.blocks[index + 1];

    if (!current || current.kind === "blank") {
      continue;
    }

    const currentTokens = tokenize(current.text);
    const windowTokens = tokenize([current.text, next?.text ?? ""].join(" "));
    const lineScore = orderedCoverage(currentTokens, transcriptTokens);
    const windowScore = orderedCoverage(windowTokens, transcriptTokens) * 0.95;
    const exactBonus = transcriptTail.includes(normalize(current.text)) ? 0.2 : 0;
    const score = Math.max(lineScore, windowScore) + exactBonus;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestScore < 0.45) {
    return args.currentIndex;
  }

  return bestIndex;
}
