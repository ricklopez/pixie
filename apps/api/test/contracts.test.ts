import assert from "node:assert/strict";
import { test } from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { eligibilityOverviewDefinition } from "@gateway/definition";
import { bootstrap } from "../src/app.js";
import { backfillPublishedContracts, prepareContractPublication, previewContract } from "../src/contracts.js";
import { openDatabase } from "../src/db.js";
import { PORTAL, TOKENS, call, publishEligibility, testApp } from "./helpers.js";

type MutableDefinition = {
  checkpoints: { objective: string }[];
  outputs: Record<string, unknown>[];
  [key: string]: unknown;
};

test("repository contracts evolve immutably and keep prior majors callable", async () => {
  const built = await testApp();
  try {
    const first = await publishEligibility(built.app, built.runs);
    const initial = await call(built.app, TOKENS.developer, "GET", `/studio/automations/${first.id}/contract`);
    assert.equal((initial.json.compatibility as { level: string }).level, "adapter");
    assert.deepEqual([
      (initial.json.current as { major: number }).major,
      (initial.json.current as { minor: number }).minor
    ], [1, 0]);
    const initialOperation = await call(built.app, TOKENS.developer, "GET", `/studio/operations?repo=${first.id}`);
    assert.equal(initialOperation.status, 200);
    assert.equal((initialOperation.json as unknown as { version: string }[])[0]?.version, "1.0");
    assert.equal((initialOperation.json as unknown as { adapterRevision: number }[])[0]?.adapterRevision, 1);
    const models = await call(built.app, TOKENS.developer, "GET", "/studio/models");
    assert.equal(models.status, 200);
    assert.equal((models.json as unknown as { identityFields: string[] }[])[0]?.identityFields[0], "memberId");
    const repositories = await call(built.app, TOKENS.developer, "GET", "/studio/repositories");
    assert.equal(repositories.status, 200);
    assert.ok((repositories.json as unknown as { name: string }[]).some((item) => item.name === first.id));

    const publishDraft = async (from: string, edit: (definition: MutableDefinition) => void) => {
      const draft = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${from}/new-draft`);
      assert.equal(draft.status, 201);
      const definition = draft.json.definition as MutableDefinition;
      edit(definition);
      const saved = await call(built.app, TOKENS.developer, "PUT", `/studio/automations/${draft.json.id}/definition`, definition);
      assert.equal(saved.status, 200, JSON.stringify(saved.json));
      const started = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${draft.json.id}/test`, { accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
      assert.equal(started.status, 202);
      await built.runs.waitForTerminal(started.json.id!);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const published = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${draft.json.id}/publish`);
      assert.equal(published.status, 201, JSON.stringify(published.json));
      return { id: String(draft.json.id), publication: published.json };
    };

    const adapter = await publishDraft(first.id, (definition) => {
      definition.checkpoints[0].objective += " Keep the same contract.";
    });
    assert.equal(adapter.publication.compatibility, "adapter");
    assert.deepEqual([
      (adapter.publication.operationVersion as { major: number }).major,
      (adapter.publication.operationVersion as { minor: number }).minor
    ], [1, 0]);
    assert.equal((adapter.publication.adapterRevision as { revision: number }).revision, 2);

    const minor = await publishDraft(adapter.id, (definition) => {
      definition.outputs.push({ name: "optionalNote", type: "string", required: false, description: "Optional note", extractor: { kind: "labelValue", checkpointId: "benefits-overview", label: "Optional note" } });
    });
    assert.equal(minor.publication.compatibility, "minor");
    assert.deepEqual(minor.publication.operationVersion && [
      (minor.publication.operationVersion as { major: number }).major,
      (minor.publication.operationVersion as { minor: number }).minor
    ], [1, 1]);

    const major = await publishDraft(minor.id, (definition) => {
      definition.outputs = definition.outputs.filter((field) => field.name !== "deductibleNetwork");
    });
    assert.equal(major.publication.compatibility, "major");
    assert.deepEqual([
      (major.publication.operationVersion as { major: number }).major,
      (major.publication.operationVersion as { minor: number }).minor
    ], [2, 0]);

    const repo = first.id;
    const missingPin = await call(built.app, TOKENS.client, "POST", `/v1/repositories/${repo}/operations/get/runs`, { accountId: "acct_demo", input: { memberId: "DEMO-1001" } });
    assert.equal(missingPin.status, 422);
    assert.match(String(missingPin.json.error), /major version/i);
    const invalidInput = await call(built.app, TOKENS.client, "POST", `/v1/repositories/${repo}/operations/get/runs`, {
      accountId: "acct_demo", input: {}
    }, { "Pixie-Contract-Version": "1" });
    assert.equal(invalidInput.status, 422);
    assert.match(JSON.stringify(invalidInput.json), /memberId/);
    const undeclared = await call(built.app, TOKENS.client, "POST", `/v1/repositories/${repo}/operations/undeclared/runs`, { input: { memberId: "DEMO-1001" } }, { "Pixie-Contract-Version": "1" });
    assert.equal(undeclared.status, 404);
    const crossTenant = await call(built.app, TOKENS.otherTenantClient, "POST", `/v1/repositories/${repo}/operations/get/runs`, { input: { memberId: "DEMO-1001" } }, { "Pixie-Contract-Version": "1" });
    assert.equal(crossTenant.status, 404);

    const runIds: string[] = [];
    for (const version of [1, 2]) {
      const started = await call(built.app, TOKENS.client, "POST", `/v1/repositories/${repo}/operations/get/runs`, {
        accountId: "acct_demo", input: { memberId: "DEMO-1001" }
      }, { "Pixie-Contract-Version": String(version) });
      assert.equal(started.status, 202);
      runIds.push(String(started.json.id));
      await built.runs.waitForTerminal(started.json.id!);
      const status = await call(built.app, TOKENS.client, "GET", `/v1/repositories/${repo}/operations/get/runs/${started.json.id}`);
      assert.equal(status.status, 200);
      assert.ok(status.json.operationVersionId);
      assert.ok(status.json.adapterRevisionId);
      const result = await call(built.app, TOKENS.client, "GET", `/v1/repositories/${repo}/operations/get/runs/${started.json.id}/result`);
      assert.equal(result.status, 200);
      assert.equal(result.json.accepted, true);
    }

    const openapi = await call(built.app, TOKENS.client, "GET", `/v1/repositories/${repo}/openapi.json`);
    assert.equal(openapi.status, 200);
    await SwaggerParser.validate(openapi.json as object);
    const paths = (openapi.json as { paths: Record<string, unknown> }).paths;
    assert.ok(Object.keys(paths).some((path) => path.includes("/operations/get/runs")));
    assert.ok(!Object.keys(paths).some((path) => path.includes("undeclared")));

    assert.throws(() => built.db.prepare("UPDATE model_versions SET minor = minor + 1").run(), /immutable/i);
    const opId = (major.publication.operationVersion as { id: string }).id;
    const retired = await call(built.app, TOKENS.developer, "POST", `/studio/operations/${opId}/retire`);
    assert.equal(retired.status, 200);
    assert.equal((retired.json.bindings as unknown[]).length, 1);
    const existingRunResult = await call(built.app, TOKENS.client, "GET", `/v1/repositories/${repo}/operations/get/runs/${runIds[1]}/result`);
    assert.equal(existingRunResult.status, 200);
    const blocked = await call(built.app, TOKENS.client, "POST", `/v1/repositories/${repo}/operations/get/runs`, {
      input: { memberId: "DEMO-1001" }
    }, { "Pixie-Contract-Version": "2" });
    assert.equal(blocked.status, 410);
  } finally {
    await built.app.close();
  }
});

test("startup backfills legacy published revisions once with undeclared identity", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant_demo', 'Legacy tenant')`).run();
    const first = { ...eligibilityOverviewDefinition(PORTAL), id: "auto-legacy", name: "Legacy automation" };
    delete first.keyFields;
    const second = { ...first, engineRevision: `${first.engineRevision}-updated` };
    const timestamp = "2025-01-01T00:00:00.000Z";
    db.prepare(`INSERT INTO automations (id, tenant_id, name, state, definition, created_at, updated_at)
      VALUES (?, 'tenant_demo', ?, 'published', ?, ?, ?)`)
      .run(first.id, first.name, JSON.stringify(second), timestamp, timestamp);
    const insertRevision = db.prepare(`INSERT INTO revisions
      (automation_id, revision, checksum, definition, published_at, published_by, test_run_id)
      VALUES (?, ?, ?, ?, ?, 'legacy', NULL)`);
    insertRevision.run(first.id, 1, "checksum-1", JSON.stringify(first), timestamp);
    insertRevision.run(first.id, 2, "checksum-2", JSON.stringify(second), "2025-01-02T00:00:00.000Z");

    bootstrap(db, TOKENS, PORTAL);
    const legacyPreview = previewContract(db, "tenant_demo", second);
    assert.equal(legacyPreview.identityLegacy, true);
    assert.equal(legacyPreview.publishable, false);
    assert.throws(
      () => prepareContractPublication(db, "tenant_demo", "legacy-repository", first.id, 3, second, "checksum-3"),
      /keyFields/
    );

    const adapters = db.prepare(`SELECT revision, automation_revision AS automationRevision
      FROM adapter_revisions WHERE automation_id = ? ORDER BY automation_revision`).all(first.id) as {
      revision: number; automationRevision: number;
    }[];
    assert.deepEqual(adapters.map(({ revision, automationRevision }) => ({ revision, automationRevision })), [
      { revision: 1, automationRevision: 1 },
      { revision: 2, automationRevision: 2 }
    ]);
    const models = db.prepare(`SELECT identity_fields AS identityFields FROM model_versions`).all() as { identityFields: string }[];
    assert.equal(models.length, 1);
    assert.deepEqual(JSON.parse(models[0]!.identityFields), ["undeclared"]);
    const operations = db.prepare(`SELECT major, minor FROM operation_versions`).all() as { major: number; minor: number }[];
    assert.deepEqual(operations.map(({ major, minor }) => ({ major, minor })), [{ major: 1, minor: 0 }]);
    const binding = db.prepare(`SELECT ar.revision FROM publication_bindings b
      JOIN adapter_revisions ar ON ar.id = b.adapter_revision_id`).get() as { revision: number };
    assert.equal(binding.revision, 2);

    bootstrap(db, TOKENS, PORTAL);
    assert.equal(backfillPublishedContracts(db), 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM adapter_revisions`).get() as { n: number }).n, 2);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM operation_versions`).get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test("built-in Todo templates publish with their declared identity", async () => {
  const built = await testApp();
  try {
    for (const template of ["create-todo", "list-todos", "update-todo", "delete-todo"] as const) {
      const created = await call(built.app, TOKENS.developer, "POST", "/studio/automations", {
        name: `Todo ${template}`,
        startUrl: "https://todo.uiineed.com/",
        template
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      const id = String(created.json.id);
      const testRunId = `completed-${template}`;
      const timestamp = new Date().toISOString();
      built.db.prepare(`INSERT INTO runs
        (id, tenant_id, automation_id, revision, account_id, caller_id, kind, state, input, created_at, started_at, finished_at)
        VALUES (?, 'tenant_demo', ?, 0, 'acct_demo', 'offline-test', 'test', 'completed', '{}', ?, ?, ?)`)
        .run(testRunId, id, timestamp, timestamp, timestamp);
      built.db.prepare(`UPDATE automations SET state = 'ready', last_test_run_id = ? WHERE id = ?`).run(testRunId, id);
      const published = await call(built.app, TOKENS.developer, "POST", `/studio/automations/${id}/publish`);
      assert.equal(published.status, 201, `${template}: ${JSON.stringify(published.json)}`);
      assert.equal(published.json.compatibility, "major");
    }
  } finally {
    await built.app.close();
  }
});
