import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const SCRYPT_COST = 16_384;
const KEY_LENGTH = 64;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_COST }).toString("hex");

  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");

  if (!salt || !expected) {
    return false;
  }

  const actual = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_COST }).toString("hex");

  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(secret: string, token: string): string {
  return createHash("sha256")
    .update(secret)
    .update(":")
    .update(token)
    .digest("hex");
}
