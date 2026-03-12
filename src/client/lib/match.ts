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

function suffixCoverage(candidateTokens: string[], transcriptTokens: string[]): number {
  if (!candidateTokens.length || !transcriptTokens.length) {
    return 0;
  }

  const candidateTail = candidateTokens.slice(-Math.min(candidateTokens.length, 5));
  const transcriptTail = transcriptTokens.slice(-Math.min(transcriptTokens.length, 8));

  return orderedCoverage(candidateTail, transcriptTail);
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
  const suffixScore = suffixCoverage(infoTokens, transcriptFocus);
  const inclusionBonus = transcriptTail.includes(normalize(candidate)) ? 0.18 : 0;

  return (
    orderScore * 0.22 +
    bagScore * 0.24 +
    bigramScore * 0.14 +
    phraseScore * 0.14 +
    suffixScore * 0.26 +
    inclusionBonus
  );
}

function scoreBlockWindow(
  blocks: ScriptBlock[],
  index: number,
  transcriptTail: string,
  transcriptTokens: string[],
  transcriptInfo: string[]
): number {
  const current = blocks[index];
  const next = blocks[index + 1];
  const nextTwo = blocks[index + 2];

  if (!current || current.kind === "blank") {
    return 0;
  }

  const variants = [
    { text: current.text, weight: 1 },
    { text: [current.text, next?.text ?? ""].join(" ").trim(), weight: 0.94 },
    { text: [current.text, next?.text ?? "", nextTwo?.text ?? ""].join(" ").trim(), weight: 0.86 }
  ].filter((variant) => variant.text);

  return variants.reduce((highest, variant) => {
    const score = scoreVariant(variant.text, transcriptTail, transcriptTokens, transcriptInfo) * variant.weight;
    return Math.max(highest, score);
  }, 0);
}

export function findBestMatchingIndex(args: {
  blocks: ScriptBlock[];
  transcript: string;
  currentIndex: number;
}): number {
  const transcriptTail = tailWords(args.transcript, 18);
  const transcriptTokens = tokenize(transcriptTail);
  const transcriptInfo = informativeTokens(transcriptTail);

  if (!transcriptTokens.length) {
    return args.currentIndex;
  }

  let bestIndex = args.currentIndex;
  let bestScore = 0;
  const start = Math.max(0, args.currentIndex - 3);
  const end = Math.min(args.blocks.length - 1, args.currentIndex + 10);
  const scores = new Map<number, number>();

  for (let index = start; index <= end; index += 1) {
    const current = args.blocks[index];

    if (!current || current.kind === "blank") {
      continue;
    }

    const proximityBias = Math.max(0, 0.08 - Math.abs(index - args.currentIndex) * 0.01);
    let score = scoreBlockWindow(args.blocks, index, transcriptTail, transcriptTokens, transcriptInfo);

    if (index < args.currentIndex) {
      score *= 0.92;
    }

    score += proximityBias;
    scores.set(index, score);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestScore < 0.34) {
    return args.currentIndex;
  }

  const forwardCandidates = [...scores.entries()]
    .filter(([index, score]) => index > args.currentIndex && score >= 0.34 && bestScore - score <= 0.08)
    .sort((left, right) => right[0] - left[0]);

  if (forwardCandidates.length > 0) {
    return forwardCandidates[0][0];
  }

  return bestIndex;
}
