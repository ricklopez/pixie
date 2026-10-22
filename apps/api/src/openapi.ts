import { inputJsonSchema, outputJsonSchema, type AutomationDefinition } from "@gateway/definition";
import type { RevisionRow } from "./db.js";

const RUN_STATES = ["queued", "running", "verifying", "completed", "needs_review", "awaiting_auth", "failed", "cancelled"];

/** Generates the OpenAPI 3.1 contract for one automation's published revisions. Only published revisions appear. */
export function openApiDocument(automationId: string, name: string, revisions: RevisionRow[], baseUrl: string) {
  const latest = revisions.at(-1);
  const def = latest ? (JSON.parse(latest.definition) as AutomationDefinition) : null;
  const revisionNumbers = revisions.map((r) => r.revision);
  const inputSchema = def ? inputJsonSchema(def) : { type: "object", properties: {}, required: [], additionalProperties: false };
  const outputSchema = def ? outputJsonSchema(def) : { type: "object", properties: {}, required: [], additionalProperties: false };
  const base = `/v1/automations/${automationId}`;
  const runRef = { $ref: "#/components/schemas/Run" };
  return {
    openapi: "3.1.0",
    info: {
      title: name,
      version: latest ? `revision-${latest.revision}` : "unpublished",
      description: def
        ? `Typed endpoint generated from a reviewed browser workflow (engine ${def.engine}@${def.engineRevision}). Results are accepted only after independent verification; \`needs_review\` runs carry no data.`
        : "No published revision yet."
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    paths: {
      [`${base}/runs`]: {
        post: {
          operationId: "createRun",
          summary: `Run ${name}`,
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" }, description: "Scoped to caller, account, revision and canonical body." }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/RunRequest" } } } },
          responses: {
            "202": { description: "Run accepted", content: { "application/json": { schema: runRef } } },
            "200": { description: "Idempotent replay of an existing run", content: { "application/json": { schema: runRef } } },
            "400": { description: "Invalid input or unknown revision" },
            "422": { description: "Input does not satisfy the published JSON schema", content: { "application/json": { schema: { $ref: "#/components/schemas/ValidationError" } } } },
            "403": { description: "Account or automation not visible to this key" },
            "404": { description: "No published automation with this id" },
            "409": { description: "Idempotency key reused with a different body" }
          }
        }
      },
      [`${base}/runs/{runId}`]: {
        get: { operationId: "getRun", parameters: [runIdParam()], responses: { "200": { description: "Run status", content: { "application/json": { schema: runRef } } }, "404": { description: "Not found" } } }
      },
      [`${base}/runs/{runId}/result`]: {
        get: {
          operationId: "getRunResult",
          parameters: [runIdParam()],
          responses: {
            "200": { description: "Verified typed result", content: { "application/json": { schema: { $ref: "#/components/schemas/RunResult" } } } },
            "202": { description: "Run not finished yet", content: { "application/json": { schema: runRef } } },
            "404": { description: "Run not found" },
            "409": { description: "Run finished without an accepted result (needs_review, awaiting_auth, failed, cancelled)", content: { "application/json": { schema: runRef } } }
          }
        }
      },
      [`${base}/runs/{runId}/evidence`]: {
        get: { operationId: "getRunEvidence", parameters: [runIdParam()], responses: { "200": { description: "Sanitized action history, model decisions, verification checks and authorized screenshot links" }, "404": { description: "Run not found" } } }
      },
      [`${base}/runs/{runId}/cancel`]: {
        post: { operationId: "cancelRun", parameters: [runIdParam()], responses: { "202": { description: "Cancellation requested" }, "409": { description: "Run already terminal" } } }
      },
      [`${base}/openapi.json`]: { get: { operationId: "getOpenApi", security: [], responses: { "200": { description: "This document" } } } }
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        RunRequest: {
          type: "object",
          required: ["revision", "accountId", "input"],
          additionalProperties: false,
          properties: {
            revision: { type: "integer", enum: revisionNumbers, description: "Published revision to execute (explicit; no implicit latest)." },
            accountId: { type: "string", description: "Portal account the run executes under. Must belong to the caller's tenant." },
            input: inputSchema
          }
        },
        ValidationError: {
          type: "object",
          required: ["error", "details"],
          properties: { error: { type: "string" }, details: { type: "array", items: { type: "string" } } }
        },
        Output: outputSchema,
        Run: {
          type: "object",
          properties: {
            id: { type: "string" },
            automationId: { type: "string" },
            revision: { type: "integer" },
            accountId: { type: "string" },
            state: { type: "string", enum: RUN_STATES },
            createdAt: { type: "string", format: "date-time" },
            finishedAt: { type: ["string", "null"], format: "date-time" },
            failure: { type: ["object", "null"] },
            metrics: { type: ["object", "null"] }
          }
        },
        RunResult: {
          type: "object",
          properties: {
            runId: { type: "string" },
            revision: { type: "integer" },
            accepted: { type: "boolean", const: true },
            data: outputSchema,
            checks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, kind: { type: "string" }, passed: { type: "boolean" }, detail: { type: "string" } } } }
          }
        }
      }
    }
  };
}

function runIdParam() {
  return { name: "runId", in: "path", required: true, schema: { type: "string" } };
}
