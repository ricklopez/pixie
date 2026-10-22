/** Writes the reference definition to the checked-in fixtures used by the worker tests and review export. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, definitionChecksum, eligibilityOverviewDefinition, inputJsonSchema, outputJsonSchema } from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const def = eligibilityOverviewDefinition();
const pretty = JSON.stringify(JSON.parse(canonicalJson(def)), null, 2) + "\n";
const targets = [resolve(root, "workers/jev/tests/eligibility-overview.json"), resolve(root, "automations/eligibility-overview/definition.json")];
for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pretty);
}
const schemas = { checksum: await definitionChecksum(def), inputSchema: inputJsonSchema(def), outputSchema: outputJsonSchema(def) };
writeFileSync(resolve(root, "automations/eligibility-overview/schemas.json"), JSON.stringify(schemas, null, 2) + "\n");
console.log(`exported ${def.id} checksum ${schemas.checksum}`);
