import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyReply, FastifyRequest } from "fastify";
import { now } from "./db.js";

export type Role = "developer" | "client";

export interface Principal {
  keyId: string;
  tenantId: string;
  role: Role;
  name: string;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createApiKey(db: DatabaseSync, tenantId: string, name: string, role: Role, token = `gw_${role}_${randomBytes(18).toString("base64url")}`) {
  const id = randomUUID();
  db.prepare(`INSERT INTO api_keys (id, tenant_id, name, token_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, tenantId, name, hashToken(token), role, now());
  return { id, token };
}

export function authenticate(db: DatabaseSync, request: FastifyRequest): Principal | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const row = db
    .prepare(`SELECT id, tenant_id, role, name FROM api_keys WHERE token_hash = ?`)
    .get(hashToken(header.slice(7).trim())) as { id: string; tenant_id: string; role: Role; name: string } | undefined;
  return row ? { keyId: row.id, tenantId: row.tenant_id, role: row.role, name: row.name } : null;
}

export function requireRole(db: DatabaseSync, role: Role | "any") {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticate(db, request);
    if (!principal) return reply.code(401).send({ error: "missing or invalid bearer token" });
    if (role !== "any" && principal.role !== role) return reply.code(403).send({ error: `requires a ${role} key` });
    request.principal = principal;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}
