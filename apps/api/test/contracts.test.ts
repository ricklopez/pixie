import assert from "node:assert/strict";
import { test } from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { TOKENS, call, publishEligibility, testApp } from "./helpers.js";

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
