import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  compatibility,
  inputJsonSchema,
  outputJsonSchema,
  type AutomationDefinition,
  type CompatibilityResult
} from "@gateway/definition";
import type { DatabaseSync } from "node:sqlite";

interface PreviousOperation {
  id: string;
  repository_id: string;
  repository_name: string;
  method: string;
  major: number;
  minor: number;
  model_version_id: string;
  automation_id: string;
  automation_revision: number;
  adapter_revision_id: string;
  adapter_revision: number;
  retired: number;
}

interface ModelVersionRecord {
  id: string;
  tenant_id: string;
  name: string;
  major: number;
  minor: number;
  schema_json: string;
  identity_fields: string;
  hash: string;
}

interface OperationVersionRecord {
  id: string;
  repository_id: string;
  method: string;
  major: number;
  minor: number;
  input_schema: string;
  model_version_id: string;
  effect: "read" | "write";
  checks: string;
  allowed_origins: string;
  connection_requirement: string;
  limits: string;
  hash: string;
}

interface AdapterRevisionRecord {
  id: string;
  operation_version_id: string;
  revision: number;
  definition_hash: string;
  engine: string;
  engine_revision: string;
  generator: "template" | "recorded" | "manual";
  source?: string | null;
  automation_id: string;
  automation_revision: number;
  hash: string;
}

export interface ContractPreview {
  repository: string;
  method: string;
  identityFields: string[];
  identityLegacy: boolean;
  compatibility: CompatibilityResult;
  current: { major: number; minor: number; adapterRevision: number } | null;
  next: { major: number; minor: number; adapterRevision: number };
  publishable: boolean;
  error?: string;
}

export interface ContractPublicationPlan {
  repositoryId: string;
  repository: string;
  method: string;
  major: number;
  minor: number;
  modelVersionId: string;
  operationVersionId: string;
  compatibility: CompatibilityResult;
  model?: ModelVersionRecord;
  operation?: OperationVersionRecord;
  adapter: AdapterRevisionRecord;
}

export function contractTarget(definition: AutomationDefinition) {
  return {
    repository: definition.repository ?? slug(definition.id),
    method: definition.method ?? (definition.effect === "read" ? "get" : slug(definition.name))
  };
}

export function previewContract(db: DatabaseSync, tenantId: string, definition: AutomationDefinition): ContractPreview {
  const target = contractTarget(definition);
  const previous = previousOperation(db, tenantId, target.repository, target.method);
  const previousDefinition = previous ? publishedDefinition(db, previous) : null;
  const normalizedNext = { ...definition, repository: target.repository, method: target.method };
  const diff = compatibility(previousDefinition, normalizedNext);
  const retired = previous ? previous.retired === 1 : false;
  const result = retired
    ? { level: "major" as const, changes: [...diff.changes, { path: "operation", kind: "retired_operation_replaced_major" }] }
    : diff;
  const identityFields = definition.keyFields ?? [];
  const publishable = identityFields.length > 0;
  const next = versionNumbers(previous, result.level);
  if (result.level === "adapter" && previous) next.adapterRevision = previous.adapter_revision + 1;
  const currentIdentity = previous
    ? db.prepare(`SELECT identity_fields FROM model_versions WHERE id = ?`).get(previous.model_version_id) as { identity_fields: string } | undefined
    : undefined;
  const identityLegacy = currentIdentity ? (JSON.parse(currentIdentity.identity_fields) as string[]).includes("undeclared") : false;
  return {
    ...target,
    identityFields,
    identityLegacy,
    compatibility: result,
    current: previous ? { major: previous.major, minor: previous.minor, adapterRevision: previous.adapter_revision } : null,
    next,
    publishable,
    ...(!publishable ? { error: "declare definition.keyFields before publishing so the model has a stable identity" } : {})
  };
}

export function prepareContractPublication(
  db: DatabaseSync,
  tenantId: string,
  repositoryId: string,
  automationId: string,
  automationRevision: number,
  definition: AutomationDefinition,
  definitionHash: string,
  allowUndeclaredIdentity = false,
  adapterSource?: string | null
): ContractPublicationPlan {
  const preview = previewContract(db, tenantId, definition);
  if (!preview.publishable && !allowUndeclaredIdentity) throw new Error(preview.error);
  const previous = previousOperation(db, tenantId, preview.repository, preview.method);
  const version = preview.next;
  const newContract = preview.compatibility.level !== "adapter" || !previous;
  const modelId = newContract ? randomUUID() : previous.model_version_id;
  const operationVersionId = newContract ? randomUUID() : previous.id;
  const modelName = `${preview.repository}.${preview.method}.output`;
  const schema = outputJsonSchema(definition);
  const identityFields = definition.keyFields ?? (allowUndeclaredIdentity ? ["undeclared"] : []);

  const modelContent = {
    id: modelId,
    tenant_id: tenantId,
    name: modelName,
    major: version.major,
    minor: version.minor,
    schema_json: canonicalJson(schema),
    identity_fields: canonicalJson(identityFields)
  };
  const model: ModelVersionRecord | undefined = newContract
    ? { ...modelContent, hash: hashCanonical(modelContent) }
    : undefined;

  const operationContent = {
    id: operationVersionId,
    repository_id: repositoryId,
    method: preview.method,
    major: version.major,
    minor: version.minor,
    input_schema: canonicalJson(inputJsonSchema(definition)),
    model_version_id: modelId,
    effect: definition.effect,
    checks: canonicalJson(definition.assertions),
    allowed_origins: canonicalJson(definition.allowedOrigins),
    connection_requirement: canonicalJson({ accountScoped: true, authRequiredSignals: definition.authRequiredSignals }),
    limits: canonicalJson(definition.limits)
  };
  const operation: OperationVersionRecord | undefined = newContract
    ? { ...operationContent, hash: hashCanonical(operationContent) }
    : undefined;
  const adapterContent = {
    id: randomUUID(),
    operation_version_id: operationVersionId,
    revision: version.adapterRevision,
    definition_hash: definitionHash,
    engine: definition.engine,
    engine_revision: definition.engineRevision,
    generator: definition.adapterGenerator ?? (definition.sourceRecordingId ? "recorded" : "manual"),
    source: adapterSource ?? null,
    automation_id: automationId,
    automation_revision: automationRevision
  };
  const adapter: AdapterRevisionRecord = { ...adapterContent, hash: hashCanonical(adapterContent) };

  return {
    repositoryId,
    repository: preview.repository,
    method: preview.method,
    major: version.major,
    minor: version.minor,
    modelVersionId: modelId,
    operationVersionId,
    compatibility: preview.compatibility,
    ...(model ? { model } : {}),
    ...(operation ? { operation } : {}),
    adapter
  };
}

export function persistContractPublication(db: DatabaseSync, plan: ContractPublicationPlan) {
  if (plan.model) {
    db.prepare(`INSERT INTO model_versions (id, tenant_id, name, major, minor, schema_json, identity_fields, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(plan.model.id, plan.model.tenant_id, plan.model.name, plan.model.major, plan.model.minor, plan.model.schema_json, plan.model.identity_fields, plan.model.hash);
  }
  if (plan.operation) {
    db.prepare(`INSERT INTO operation_versions (id, repository_id, method, major, minor, input_schema, model_version_id, effect, checks, allowed_origins, connection_requirement, limits, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        plan.operation.id,
        plan.operation.repository_id,
        plan.operation.method,
        plan.operation.major,
        plan.operation.minor,
        plan.operation.input_schema,
        plan.operation.model_version_id,
        plan.operation.effect,
        plan.operation.checks,
        plan.operation.allowed_origins,
        plan.operation.connection_requirement,
        plan.operation.limits,
        plan.operation.hash
      );
  }
  db.prepare(`INSERT INTO adapter_revisions (id, operation_version_id, revision, definition_hash, engine, engine_revision, generator, source, automation_id, automation_revision, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      plan.adapter.id,
      plan.adapter.operation_version_id,
      plan.adapter.revision,
      plan.adapter.definition_hash,
      plan.adapter.engine,
      plan.adapter.engine_revision,
      plan.adapter.generator,
      plan.adapter.source ?? null,
      plan.adapter.automation_id,
      plan.adapter.automation_revision,
      plan.adapter.hash
    );
  db.prepare(`INSERT INTO publication_bindings (repository_id, method, major, operation_version_id, adapter_revision_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, method, major) DO UPDATE SET
      operation_version_id = excluded.operation_version_id, adapter_revision_id = excluded.adapter_revision_id`)
    .run(plan.repositoryId, plan.method, plan.major, plan.operation?.id ?? plan.adapter.operation_version_id, plan.adapter.id);
}

export function backfillPublishedContracts(db: DatabaseSync): number {
  const missing = db.prepare(`SELECT a.tenant_id AS tenantId, a.id AS automationId, r.revision AS automationRevision,
      r.definition, r.checksum
    FROM revisions r
    JOIN automations a ON a.id = r.automation_id
    WHERE NOT EXISTS (
      SELECT 1 FROM adapter_revisions ar
      WHERE ar.automation_id = r.automation_id AND ar.automation_revision = r.revision
    )
    ORDER BY r.published_at, r.automation_id, r.revision`).all() as {
    tenantId: string;
    automationId: string;
    automationRevision: number;
    definition: string;
    checksum: string;
  }[];
  let created = 0;

  for (const revision of missing) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (db.prepare(`SELECT 1 FROM adapter_revisions WHERE automation_id = ? AND automation_revision = ?`)
        .get(revision.automationId, revision.automationRevision)) {
        db.exec("COMMIT");
        continue;
      }
      const definition = JSON.parse(revision.definition) as AutomationDefinition;
      const target = contractTarget(definition);
      db.prepare(`INSERT OR IGNORE INTO repositories (id, tenant_id, name) VALUES (?, ?, ?)`)
        .run(randomUUID(), revision.tenantId, target.repository);
      const repository = db.prepare(`SELECT id FROM repositories WHERE tenant_id = ? AND name = ?`)
        .get(revision.tenantId, target.repository) as { id: string };
      const plan = prepareContractPublication(
        db,
        revision.tenantId,
        repository.id,
        revision.automationId,
        revision.automationRevision,
        definition,
        revision.checksum,
        true
      );
      persistContractPublication(db, plan);
      db.exec("COMMIT");
      created += 1;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return created;
}

export function listModels(db: DatabaseSync, tenantId: string) {
  return (db.prepare(`SELECT mv.id, mv.name, mv.major, mv.minor, mv.schema_json AS schema, mv.identity_fields AS identityFields, mv.hash
    FROM model_versions mv WHERE mv.tenant_id = ? ORDER BY mv.name, mv.major, mv.minor`).all(tenantId) as {
    id: string; name: string; major: number; minor: number; schema: string; identityFields: string; hash: string
  }[]).map((row) => ({ ...row, schema: JSON.parse(row.schema), identityFields: JSON.parse(row.identityFields) }));
}

export function listRepositories(db: DatabaseSync, tenantId: string) {
  return db.prepare(`SELECT r.id, r.name, COUNT(DISTINCT b.method) AS operationCount FROM repositories r
    LEFT JOIN publication_bindings b ON b.repository_id = r.id
    LEFT JOIN retired_operations ro ON ro.operation_version_id = b.operation_version_id
    WHERE r.tenant_id = ? AND ro.operation_version_id IS NULL GROUP BY r.id ORDER BY r.name`).all(tenantId) as {
    id: string; name: string; operationCount: number
  }[];
}

export function listRepositoryOperations(db: DatabaseSync, tenantId: string, repository?: string) {
  const rows = db.prepare(`SELECT r.name AS repository, ov.id AS operationVersionId, ov.method, ov.major, ov.minor,
      ov.input_schema AS inputSchema, ov.model_version_id AS modelVersionId, mv.schema_json AS outputSchema,
      ov.effect, ov.hash, ar.id AS adapterRevisionId, ar.revision AS adapterRevision, ar.hash AS adapterHash,
      ar.automation_id AS automationId
    FROM repositories r
    JOIN publication_bindings b ON b.repository_id = r.id
    JOIN operation_versions ov ON ov.id = b.operation_version_id
    JOIN model_versions mv ON mv.id = ov.model_version_id
    JOIN adapter_revisions ar ON ar.id = b.adapter_revision_id
    LEFT JOIN retired_operations ro ON ro.operation_version_id = ov.id
    WHERE r.tenant_id = ? AND ro.operation_version_id IS NULL AND (? IS NULL OR r.name = ?)
    ORDER BY r.name, ov.method, ov.major`).all(tenantId, repository ?? null, repository ?? null) as {
    repository: string; operationVersionId: string; method: string; major: number; minor: number; inputSchema: string;
    modelVersionId: string; outputSchema: string; effect: string; hash: string; adapterRevisionId: string; adapterRevision: number; adapterHash: string; automationId: string
  }[];
  return rows.map((row) => ({
    ...row,
    version: `${row.major}.${row.minor}`,
    inputSchema: JSON.parse(row.inputSchema),
    outputSchema: JSON.parse(row.outputSchema)
  }));
}

export function retireOperation(db: DatabaseSync, tenantId: string, operationVersionId: string, retiredBy: string) {
  const operation = db.prepare(`SELECT ov.id, r.name AS repository, ov.method, ov.major, ov.minor
    FROM operation_versions ov JOIN repositories r ON r.id = ov.repository_id
    WHERE ov.id = ? AND r.tenant_id = ?`).get(operationVersionId, tenantId) as {
    id: string; repository: string; method: string; major: number; minor: number
  } | undefined;
  if (!operation) return null;
  const bindings = db.prepare(`SELECT b.method, b.major, b.adapter_revision_id AS adapterRevisionId
    FROM publication_bindings b WHERE b.operation_version_id = ? ORDER BY b.method, b.major`).all(operationVersionId) as {
    method: string; major: number; adapterRevisionId: string
  }[];
  db.prepare(`INSERT INTO retired_operations (operation_version_id, retired_at, retired_by) VALUES (?, ?, ?)
    ON CONFLICT(operation_version_id) DO NOTHING`).run(operationVersionId, new Date().toISOString(), retiredBy);
  return { operation: { ...operation, version: `${operation.major}.${operation.minor}` }, bindings };
}

export function operationBinding(db: DatabaseSync, tenantId: string, repository: string, method: string, major: number) {
  return db.prepare(`SELECT ov.*, r.name AS repository_name, ar.id AS adapter_revision_id, ar.revision AS adapter_revision,
      ar.automation_id, ar.automation_revision, ar.hash AS adapter_hash,
      EXISTS (SELECT 1 FROM retired_operations ro WHERE ro.operation_version_id = ov.id) AS retired
    FROM repositories r
    JOIN publication_bindings b ON b.repository_id = r.id
    JOIN operation_versions ov ON ov.id = b.operation_version_id
    JOIN adapter_revisions ar ON ar.id = b.adapter_revision_id
    WHERE r.tenant_id = ? AND r.name = ? AND ov.method = ? AND b.major = ?`)
    .get(tenantId, repository, method, major) as (PreviousOperation & Record<string, unknown>) | undefined;
}

function previousOperation(db: DatabaseSync, tenantId: string, repository: string, method: string): PreviousOperation | undefined {
  return db.prepare(`SELECT ov.id, ov.repository_id, r.name AS repository_name, ov.method, ov.major, ov.minor, ov.model_version_id,
      ar.automation_id, ar.automation_revision, ar.id AS adapter_revision_id, ar.revision AS adapter_revision,
      EXISTS (SELECT 1 FROM retired_operations ro WHERE ro.operation_version_id = ov.id) AS retired
    FROM operation_versions ov
    JOIN repositories r ON r.id = ov.repository_id
    JOIN adapter_revisions ar ON ar.operation_version_id = ov.id
    WHERE r.tenant_id = ? AND r.name = ? AND ov.method = ?
    ORDER BY ov.major DESC, ov.minor DESC, ar.revision DESC LIMIT 1`).get(tenantId, repository, method) as unknown as PreviousOperation | undefined;
}

function publishedDefinition(db: DatabaseSync, previous: PreviousOperation) {
  const row = db.prepare(`SELECT definition FROM revisions WHERE automation_id = ? AND revision = ?`)
    .get(previous.automation_id, previous.automation_revision) as { definition: string } | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.definition) as AutomationDefinition), repository: previous.repository_name, method: previous.method };
}

function versionNumbers(previous: PreviousOperation | undefined, level: CompatibilityResult["level"]) {
  if (!previous) return { major: 1, minor: 0, adapterRevision: 1 };
  if (level === "major") return { major: previous.major + 1, minor: 0, adapterRevision: 1 };
  if (level === "minor") return { major: previous.major, minor: previous.minor + 1, adapterRevision: 1 };
  return { major: previous.major, minor: previous.minor, adapterRevision: previous.adapter_revision + 1 };
}

function slug(value: string) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return result || "operation";
}

function hashCanonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
