import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../shared/canonical.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function frozenInputs(): Promise<string[]> {
  const contractFiles = (await readdir(resolve(root, "contract")))
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => `contract/${name}`);
  const frozenFiles = (await readdir(resolve(root, "test/frozen")))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/frozen/${name}`);
  return [...contractFiles, ...frozenFiles].sort();
}

export async function computeContractLock(): Promise<{ sha256: string; files: string[] }> {
  const files = await frozenInputs();
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(Buffer.from(file), Buffer.from([0]), await readFile(resolve(root, file)), Buffer.from([0]));
  }
  return { sha256: sha256(Buffer.concat(chunks)), files };
}

export async function verifyContractLock(): Promise<void> {
  const lock = JSON.parse(await readFile(resolve(root, "contract.lock.json"), "utf8")) as { sha256: string; files: string[] };
  const current = await computeContractLock();
  if (lock.sha256 !== current.sha256 || JSON.stringify(lock.files) !== JSON.stringify(current.files)) {
    throw new Error(`frozen contract/test lock mismatch: expected ${lock.sha256}, got ${current.sha256}`);
  }
}

export async function writeContractLock(): Promise<void> {
  const lock = await computeContractLock();
  await writeFile(resolve(root, "contract.lock.json"), `${JSON.stringify({ algorithm: "sha256", ...lock }, null, 2)}\n`);
}
