import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLICATION_MAX_BYTES,
  activatePublication,
  recordActivationSmoke,
  stagePublicationActivation,
  storePublicationArtifact
} from "../src/publication.js";
import { buildApp } from "../src/app.js";
import { TOKENS, call, publishEligibility, testApp } from "./helpers.js";

test("publication bundle is bounded, pinned, immutable, and reused by canonical hash", async () => {
  const built = await testApp();
  try {
    const published = await publishEligibility(built.app, built.runs);
    const repeated = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${published.id}/publish`);
    assert.equal(repeated.status, 201);
    assert.equal((repeated.json.artifact as { reused: boolean }).reused, true);
    const history = await call(built.app, TOKENS.developer, "GET", `/studio/automations/${published.id}/publications`);
    assert.equal(history.status, 200);
    const activationId = (history.json.activations as { id: string; state: string; artifactHash: string }[])[0]!.id;
    assert.equal((history.json.activations as { state: string }[])[0]?.state, "active");
    const activation = await call(built.app, TOKENS.developer, "GET", `/studio/activations/${activationId}`);
    assert.equal(activation.status, 200);
    assert.equal(activation.json.state, "active");
    const artifact = built.db.prepare(`SELECT * FROM publication_artifacts`).get() as {
      hash: string; tenant_id: string; adapter_revision_id: string; size: number; content: string;
    };
    const linked = built.db.prepare(`SELECT ar.source, ar.operation_version_id AS operationVersionId,
        ov.model_version_id AS modelVersionId, r.definition
      FROM adapter_revisions ar
      JOIN operation_versions ov ON ov.id = ar.operation_version_id
      JOIN revisions r ON r.automation_id = ar.automation_id AND r.revision = ar.automation_revision
      WHERE ar.id = ?`).get(artifact.adapter_revision_id) as {
      source: string | null; operationVersionId: string; modelVersionId: string; definition: string;
    };
    const reused = storePublicationArtifact(built.db, {
      tenantId: artifact.tenant_id,
      adapterRevisionId: artifact.adapter_revision_id,
      source: linked.source,
      definition: JSON.parse(linked.definition),
      operationVersionId: linked.operationVersionId,
      modelVersionId: linked.modelVersionId
    });
    assert.equal(reused.hash, artifact.hash);
    assert.equal(reused.reused, true);
    assert.equal(JSON.parse(artifact.content).runtimeVersion, "0.1.0");
    assert.ok(artifact.size <= PUBLICATION_MAX_BYTES);
    assert.throws(() => storePublicationArtifact(built.db, {
      tenantId: artifact.tenant_id, adapterRevisionId: artifact.adapter_revision_id,
      source: "x".repeat(PUBLICATION_MAX_BYTES), definition: {}, operationVersionId: linked.operationVersionId,
      modelVersionId: linked.modelVersionId
    }), /exceeds/);
    assert.throws(() => storePublicationArtifact(built.db, {
      tenantId: artifact.tenant_id, adapterRevisionId: artifact.adapter_revision_id,
      source: null, definition: {}, operationVersionId: linked.operationVersionId,
      modelVersionId: linked.modelVersionId, dependencies: { "other-package": "1.0.0" }
    }), /not allowed/);
    assert.throws(() => storePublicationArtifact(built.db, {
      tenantId: artifact.tenant_id, adapterRevisionId: artifact.adapter_revision_id,
      source: null, definition: {}, operationVersionId: linked.operationVersionId,
      modelVersionId: linked.modelVersionId, dependencies: { "@gateway/adapter": "latest" }
    }), /pinned/);
    assert.throws(() => built.db.prepare(`UPDATE publication_artifacts SET size = size + 1 WHERE hash = ?`).run(artifact.hash), /immutable/);
    const smoke = built.db.prepare(`SELECT pa.smoke_run_id AS smokeRunId, pa.adapter_revision_id AS adapterRevisionId,
        r.kind, r.state, r.adapter_revision_id AS runAdapterRevisionId
      FROM publication_activations pa JOIN runs r ON r.id = pa.smoke_run_id
      WHERE pa.state = 'active'`).get() as {
      smokeRunId: string; adapterRevisionId: string; kind: string; state: string; runAdapterRevisionId: string;
    };
    assert.equal(smoke.kind, "test");
    assert.equal(smoke.state, "completed");
    assert.equal(smoke.runAdapterRevisionId, smoke.adapterRevisionId);
    assert.equal(published.revision, 1);
  } finally {
    await built.app.close();
  }
});

test("failed publication smoke leaves the previous active binding unchanged", async () => {
  const runnerOptions: { failOnRunNumber?: number } = {};
  const built = await testApp(runnerOptions);
  try {
    const first = await publishEligibility(built.app, built.runs);
    const bindingBefore = built.db.prepare(`SELECT adapter_revision_id FROM publication_bindings`).get() as { adapter_revision_id: string };
    const draft = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${first.id}/new-draft`);
    assert.equal(draft.status, 201);
    const saved = await call(built.app, TOKENS.developer, "PUT", `/studio/automations/${draft.json.id}/definition`, draft.json.definition);
    assert.equal(saved.status, 200);
    const testRun = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${draft.json.id}/test`, {
      accountId: "acct_demo", input: { memberId: "DEMO-1001" }
    });
    assert.equal(testRun.status, 202);
    await built.runs.waitForTerminal(testRun.json.id!);
    runnerOptions.failOnRunNumber = 4;
    const failed = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${draft.json.id}/publish`);
    assert.equal(failed.status, 409);
    assert.match(String(failed.json.error), /smoke test failed/);
    const bindingAfter = built.db.prepare(`SELECT adapter_revision_id FROM publication_bindings`).get() as { adapter_revision_id: string };
    assert.equal(bindingAfter.adapter_revision_id, bindingBefore.adapter_revision_id);
    assert.equal(failed.json.activationState, "failed");
  } finally {
    await built.app.close();
  }
});

test("startup reconciliation handles crashes after staging, smoke, and the binding switch", async () => {
  const built = await testApp();
  try {
    const published = await publishEligibility(built.app, built.runs);
    const active = built.db.prepare(`SELECT b.repository_id AS repositoryId, b.method, b.major,
        b.operation_version_id AS operationVersionId, b.adapter_revision_id AS adapterRevisionId,
        a.tenant_id AS tenantId, a.hash AS artifactHash
      FROM publication_bindings b
      JOIN adapter_revisions ar ON ar.id = b.adapter_revision_id
      JOIN publication_artifacts a ON a.adapter_revision_id = ar.id
      WHERE ar.automation_id = ?`).get(published.id) as {
      repositoryId: string; method: string; major: number; operationVersionId: string;
      adapterRevisionId: string; tenantId: string; artifactHash: string;
    };
    const stagedCrash = stagePublicationActivation(built.db, active);
    const restart = () => buildApp({
      db: built.db,
      runner: built.runner,
      evidenceRoot: "/tmp/pixie-publication-test",
      cdpUrl: async () => "",
      allowLoopback: true,
      publicBaseUrl: "http://gateway.test",
      selectEngine: () => ({ engine: "scripted", script: [] })
    });
    let restarted = restart();
    await restarted.app.ready();
    await restarted.app.close();
    assert.equal((built.db.prepare(`SELECT state FROM publication_activations WHERE id = ?`).get(stagedCrash) as { state: string }).state, "abandoned");

    const smokeCrash = stagePublicationActivation(built.db, active);
    recordActivationSmoke(built.db, smokeCrash, published.testRunId);
    restarted = restart();
    await restarted.app.ready();
    await restarted.app.close();
    assert.equal((built.db.prepare(`SELECT state FROM publication_activations WHERE id = ?`).get(smokeCrash) as { state: string }).state, "active");

    const switchCrash = stagePublicationActivation(built.db, active);
    recordActivationSmoke(built.db, switchCrash, published.testRunId);
    built.db.prepare(`UPDATE publication_activations SET state = 'smoked' WHERE id = ?`).run(switchCrash);
    restarted = restart();
    await restarted.app.ready();
    await restarted.app.close();
    assert.equal((built.db.prepare(`SELECT state FROM publication_activations WHERE id = ?`).get(switchCrash) as { state: string }).state, "active");
    assert.equal(activatePublication(built.db, switchCrash), false);

    const failedSmoke = stagePublicationActivation(built.db, active);
    recordActivationSmoke(built.db, failedSmoke, published.testRunId);
    built.db.prepare(`UPDATE publication_activations SET state = 'smoked' WHERE id = ?`).run(failedSmoke);
    built.db.prepare(`UPDATE runs SET state = 'failed' WHERE id = ?`).run(published.testRunId);
    restarted = restart();
    await restarted.app.ready();
    await restarted.app.close();
    assert.equal((built.db.prepare(`SELECT state FROM publication_activations WHERE id = ?`).get(failedSmoke) as { state: string }).state, "abandoned");
    const binding = built.db.prepare(`SELECT adapter_revision_id FROM publication_bindings`).get() as { adapter_revision_id: string };
    assert.equal(binding.adapter_revision_id, active.adapterRevisionId);
  } finally {
    await built.app.close();
  }
});
