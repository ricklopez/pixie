import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@gateway/definition";
import type { DatabaseSync } from "node:sqlite";

export const PUBLICATION_MAX_BYTES = 256 * 1024;
export const PUBLICATION_RUNTIME_VERSION = "0.1.0";
export const PUBLICATION_DEPENDENCIES = Object.freeze({ "@gateway/adapter": "0.1.0" });

export interface PublicationArtifactInput {
  tenantId: string;
  adapterRevisionId: string;
  source: string | null;
  definition: unknown;
  operationVersionId: string;
  modelVersionId: string;
  dependencies?: Record<string, string>;
}

export function storePublicationArtifact(db: DatabaseSync, input: PublicationArtifactInput) {
  const dependencies = input.dependencies ?? PUBLICATION_DEPENDENCIES;
  if (Object.keys(dependencies).length !== 1 || Object.keys(dependencies).some((name) => name !== "@gateway/adapter")) {
    throw new Error("publication dependency is not allowed");
  }
  if (dependencies["@gateway/adapter"] !== PUBLICATION_DEPENDENCIES["@gateway/adapter"]) {
    throw new Error("publication dependencies must use the pinned @gateway/adapter runtime");
  }
  const content = canonicalJson({
    tenantId: input.tenantId,
    adapterSource: input.source,
    definition: input.definition,
    contractReferences: { operationVersionId: input.operationVersionId, modelVersionId: input.modelVersionId },
    runtimeVersion: PUBLICATION_RUNTIME_VERSION,
    dependencies
  });
  const size = Buffer.byteLength(content, "utf8");
  if (size > PUBLICATION_MAX_BYTES) throw new Error(`publication bundle exceeds ${PUBLICATION_MAX_BYTES} bytes`);
  const hash = createHash("sha256").update(content).digest("hex");
  const manifest = canonicalJson({
    formatVersion: 1,
    runtimeVersion: PUBLICATION_RUNTIME_VERSION,
    dependencies,
    operationVersionId: input.operationVersionId,
    modelVersionId: input.modelVersionId
  });
  const inserted = db.prepare(`INSERT OR IGNORE INTO publication_artifacts
    (hash, tenant_id, adapter_revision_id, size, manifest, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(hash, input.tenantId, input.adapterRevisionId, size, manifest, content, new Date().toISOString());
  const stored = db.prepare(`SELECT tenant_id, size, content FROM publication_artifacts WHERE hash = ?`).get(hash) as
    { tenant_id: string; size: number; content: string } | undefined;
  if (!stored || stored.tenant_id !== input.tenantId || stored.content !== content) {
    throw new Error("publication artifact hash collision");
  }
  return { hash, size, reused: Number(inserted.changes) === 0, content, manifest };
}

export function stagePublicationActivation(
  db: DatabaseSync,
  input: {
    tenantId: string;
    repositoryId: string;
    method: string;
    major: number;
    operationVersionId: string;
    adapterRevisionId: string;
    artifactHash: string;
    artifactReused?: boolean;
  }
) {
  const previous = db.prepare(`SELECT adapter_revision_id FROM publication_bindings
    WHERE repository_id = ? AND method = ? AND major = ?`).get(input.repositoryId, input.method, input.major) as
    { adapter_revision_id: string } | undefined;
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO publication_activations
    (id, tenant_id, repository_id, method, major, operation_version_id, adapter_revision_id,
     artifact_hash, artifact_reused, previous_adapter_revision_id, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)`)
    .run(id, input.tenantId, input.repositoryId, input.method, input.major, input.operationVersionId,
      input.adapterRevisionId, input.artifactHash, input.artifactReused ? 1 : 0,
      previous?.adapter_revision_id ?? null, timestamp, timestamp);
  return id;
}

export function recordActivationSmoke(db: DatabaseSync, activationId: string, smokeRunId: string) {
  db.prepare(`UPDATE publication_activations SET smoke_run_id = ?, updated_at = ?
    WHERE id = ? AND state = 'staged'`).run(smokeRunId, new Date().toISOString(), activationId);
}

export function failPublicationActivation(db: DatabaseSync, activationId: string, failure: string) {
  db.prepare(`UPDATE publication_activations SET state = 'failed', failure = ?, updated_at = ?
    WHERE id = ? AND state IN ('staged','smoked')`).run(failure, new Date().toISOString(), activationId);
}

function finishActivation(db: DatabaseSync, activationId: string): boolean {
  const activation = db.prepare(`SELECT * FROM publication_activations WHERE id = ?`).get(activationId) as {
    id: string; tenant_id: string; repository_id: string; method: string; major: number;
    operation_version_id: string; adapter_revision_id: string; artifact_hash: string;
    previous_adapter_revision_id: string | null; smoke_run_id: string | null; state: string;
  } | undefined;
  if (!activation || !["staged", "smoked"].includes(activation.state)) return false;
  const smoke = activation.smoke_run_id
    ? db.prepare(`SELECT state FROM runs WHERE id = ?`).get(activation.smoke_run_id) as { state: string } | undefined
    : undefined;
  if (smoke?.state !== "completed") {
    db.prepare(`UPDATE publication_activations SET state = 'abandoned', failure = 'smoke test did not pass', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), activationId);
    return false;
  }
  const artifact = db.prepare(`SELECT tenant_id, content FROM publication_artifacts WHERE hash = ?`).get(activation.artifact_hash) as
    { tenant_id: string; content: string } | undefined;
  const adapter = db.prepare(`SELECT source FROM adapter_revisions WHERE id = ?`).get(activation.adapter_revision_id) as
    { source: string | null } | undefined;
  let validArtifact = false;
  if (artifact && adapter && artifact.tenant_id === activation.tenant_id) {
    try {
      const parsed = JSON.parse(artifact.content) as { adapterSource?: string | null };
      validArtifact = parsed.adapterSource === adapter.source &&
        createHash("sha256").update(artifact.content).digest("hex") === activation.artifact_hash;
    } catch {
      validArtifact = false;
    }
  }
  if (!validArtifact) {
    db.prepare(`UPDATE publication_activations SET state = 'abandoned', failure = 'artifact hash or adapter source mismatch', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), activationId);
    return false;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare(`SELECT adapter_revision_id FROM publication_bindings
      WHERE repository_id = ? AND method = ? AND major = ?`)
      .get(activation.repository_id, activation.method, activation.major) as { adapter_revision_id: string } | undefined;
    if (current?.adapter_revision_id === activation.adapter_revision_id) {
      const timestamp = new Date().toISOString();
      db.prepare(`UPDATE publication_activations SET state = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, activationId);
      db.exec("COMMIT");
      return true;
    }
    if ((current?.adapter_revision_id ?? null) !== activation.previous_adapter_revision_id) {
      db.prepare(`UPDATE publication_activations SET state = 'abandoned', failure = 'active binding changed during activation', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), activationId);
      db.exec("COMMIT");
      return false;
    }
    db.prepare(`INSERT INTO publication_bindings
      (repository_id, method, major, operation_version_id, adapter_revision_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, method, major) DO UPDATE SET
        operation_version_id = excluded.operation_version_id,
        adapter_revision_id = excluded.adapter_revision_id`)
      .run(activation.repository_id, activation.method, activation.major,
        activation.operation_version_id, activation.adapter_revision_id);
    const timestamp = new Date().toISOString();
    db.prepare(`UPDATE publication_activations SET state = 'active', activated_at = ?, updated_at = ? WHERE id = ?`)
      .run(timestamp, timestamp, activationId);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function reconcilePublicationActivations(db: DatabaseSync) {
  const pending = db.prepare(`SELECT id, state, smoke_run_id AS smokeRunId FROM publication_activations
    WHERE state IN ('staged','smoked') ORDER BY created_at, id`).all() as
    { id: string; state: "staged" | "smoked"; smokeRunId: string | null }[];
  for (const item of pending) {
    if (item.state === "staged") {
      const run = item.smokeRunId
        ? db.prepare(`SELECT state FROM runs WHERE id = ?`).get(item.smokeRunId) as { state: string } | undefined
        : undefined;
      if (run?.state !== "completed") {
        db.prepare(`UPDATE publication_activations SET state = 'abandoned', failure = 'smoke test did not pass', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), item.id);
        continue;
      }
      const timestamp = new Date().toISOString();
      db.prepare(`UPDATE publication_activations SET state = 'smoked', smoked_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, item.id);
    }
    finishActivation(db, item.id);
  }
}

export function activatePublication(db: DatabaseSync, activationId: string) {
  const row = db.prepare(`SELECT smoke_run_id AS smokeRunId FROM publication_activations WHERE id = ?`).get(activationId) as
    { smokeRunId: string | null } | undefined;
  if (!row?.smokeRunId) throw new Error("activation has no smoke run");
  const smoke = db.prepare(`SELECT state FROM runs WHERE id = ?`).get(row.smokeRunId) as { state: string } | undefined;
  if (smoke?.state !== "completed") {
    failPublicationActivation(db, activationId, "smoke test failed");
    return false;
  }
  const timestamp = new Date().toISOString();
  db.prepare(`UPDATE publication_activations SET state = 'smoked', smoked_at = ?, updated_at = ? WHERE id = ? AND state = 'staged'`)
    .run(timestamp, timestamp, activationId);
  return finishActivation(db, activationId);
}
