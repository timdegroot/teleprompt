import type { ScriptBlock } from "../types";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "then",
  "there",
  "this",
  "to",
  "up",
  "we",
  "with",
  "you",
  "your"
]);

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

function informativeTokens(value: string): string[] {
  return tokenize(value).filter((token) => token.length > 2 && !STOPWORDS.has(token));
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

function setCoverage(candidateTokens: string[], transcriptTokens: string[]): number {
  if (!candidateTokens.length || !transcriptTokens.length) {
    return 0;
  }

  const transcriptSet = new Set(transcriptTokens);
  const candidateSet = [...new Set(candidateTokens)];
  const matches = candidateSet.filter((token) => transcriptSet.has(token)).length;

  return matches / candidateSet.length;
}

function ngrams(tokens: string[], size: number): string[] {
  if (tokens.length < size) {
    return [];
  }

  const output: string[] = [];

  for (let index = 0; index <= tokens.length - size; index += 1) {
    output.push(tokens.slice(index, index + size).join(" "));
  }

  return output;
}

function diceCoefficient(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  const leftBigrams = ngrams(tokenize(left), 2);
  const rightBigrams = ngrams(tokenize(right), 2);

  if (!leftBigrams.length || !rightBigrams.length) {
    return setCoverage(tokenize(left), tokenize(right));
  }

  const rightCounts = new Map<string, number>();

  rightBigrams.forEach((gram) => {
    rightCounts.set(gram, (rightCounts.get(gram) ?? 0) + 1);
  });

  let matches = 0;

  leftBigrams.forEach((gram) => {
    const count = rightCounts.get(gram) ?? 0;

    if (count > 0) {
      matches += 1;
      rightCounts.set(gram, count - 1);
    }
  });

  return (2 * matches) / (leftBigrams.length + rightBigrams.length);
}

function tailWords(value: string, count: number): string {
  const words = tokenize(value);
  return words.slice(Math.max(0, words.length - count)).join(" ");
}

function scoreVariant(candidate: string, transcriptTail: string, transcriptTokens: string[], transcriptInfo: string[]): number {
  const candidateTokens = tokenize(candidate);
  const candidateInfo = informativeTokens(candidate);
  const infoTokens = candidateInfo.length ? candidateInfo : candidateTokens;
  const transcriptFocus = transcriptInfo.length ? transcriptInfo : transcriptTokens;
  const orderScore = orderedCoverage(infoTokens, transcriptFocus);
  const bagScore = setCoverage(infoTokens, transcriptFocus);
  const bigramScore = setCoverage(ngrams(infoTokens, 2), ngrams(transcriptFocus, 2));
  const phraseScore = diceCoefficient(candidate, transcriptTail);
  const inclusionBonus = transcriptTail.includes(normalize(candidate)) ? 0.18 : 0;

  return orderScore * 0.32 + bagScore * 0.34 + bigramScore * 0.18 + phraseScore * 0.16 + inclusionBonus;
}

export function findBestMatchingIndex(args: {
  blocks: ScriptBlock[];
  transcript: string;
  currentIndex: number;
}): number {
  const transcriptTail = tailWords(args.transcript, 64);
  const transcriptTokens = tokenize(transcriptTail);
  const transcriptInfo = informativeTokens(transcriptTail);

  if (!transcriptTokens.length) {
    return args.currentIndex;
  }

  let bestIndex = args.currentIndex;
  let bestScore = 0;
  const start = Math.max(0, args.currentIndex - 3);
  const end = Math.min(args.blocks.length - 1, args.currentIndex + 10);

  for (let index = start; index <= end; index += 1) {
    const current = args.blocks[index];
    const next = args.blocks[index + 1];
    const nextTwo = args.blocks[index + 2];

    if (!current || current.kind === "blank") {
      continue;
    }

    const variants = [
      current.text,
      [current.text, next?.text ?? ""].join(" ").trim(),
      [current.text, next?.text ?? "", nextTwo?.text ?? ""].join(" ").trim()
    ].filter(Boolean);
    const proximityBias = Math.max(0, 0.08 - Math.abs(index - args.currentIndex) * 0.01);
    let score = variants.reduce(
      (highest, variant) => Math.max(highest, scoreVariant(variant, transcriptTail, transcriptTokens, transcriptInfo)),
      0
    );

    if (index < args.currentIndex) {
      score *= 0.92;
    }

    score += proximityBias;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestScore < 0.34) {
    return args.currentIndex;
  }

  return bestIndex;
}
