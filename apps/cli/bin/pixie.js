#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/main.js");
if (!existsSync(dist)) {
  console.error("pixie is not built yet: run `npm run build` in the gateway checkout first.");
  process.exit(2);
}
const { main } = await import(dist);
process.exitCode = await main(process.argv.slice(2));
