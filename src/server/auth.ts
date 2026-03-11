import type { FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import cookie from "@fastify/cookie";

import { config } from "./config.js";
import { createSession, deleteSession, findSessionUser, type UserRecord } from "./repositories.js";
import { generateSessionToken } from "./security.js";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRecord | null;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(async (app) => {
  await app.register(cookie, {
    secret: config.sessionSecret
  });

  app.decorateRequest("user", null);

  app.decorate("authenticate", async (request, reply) => {
    const token = request.cookies[config.sessionCookieName];

    if (!token) {
      return reply.code(401).send({ message: "Authentication required." });
    }

    const user = await findSessionUser(config.sessionSecret, token);

    if (!user) {
      reply.clearCookie(config.sessionCookieName, {
        path: "/"
      });
      return reply.code(401).send({ message: "Session expired." });
    }

    request.user = user;
  });

  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);

    if (reply.sent) {
      return;
    }

    if (request.user?.role !== "admin") {
      return reply.code(403).send({ message: "Admin access required." });
    }
  });
});

export async function issueSessionCookie(reply: import("fastify").FastifyReply, userId: string): Promise<void> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionDurationDays * 24 * 60 * 60 * 1000);

  await createSession({
    userId,
    token,
    secret: config.sessionSecret,
    expiresAt
  });

  reply.setCookie(config.sessionCookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt
  });
}

export async function clearSessionCookie(
  request: import("fastify").FastifyRequest,
  reply: import("fastify").FastifyReply
): Promise<void> {
  const token = request.cookies[config.sessionCookieName];

  if (token) {
    await deleteSession(config.sessionSecret, token);
  }

  reply.clearCookie(config.sessionCookieName, {
    path: "/"
  });
}
