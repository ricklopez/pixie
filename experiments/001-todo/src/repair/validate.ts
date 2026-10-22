import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "../shared/canonical.js";
import { verifyContractLock } from "../contract/lock.js";
import { runFrozenCandidateSuite } from "./validation-suite.js";
import type { Operation } from "../shared/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface CandidateChange {
  path: string;
  content: string;
}

export interface CandidateValidation {
  accepted: boolean;
  candidateHash: string;
  reasons: string[];
}

const allowedPath = /^generated\/(?:baseline|candidate|[a-z0-9-]+)\/(create|list|rename|delete)\.ts$/;

export async function validateCandidate(changes: CandidateChange[]): Promise<CandidateValidation> {
  const candidateHash = sha256(changes.map((change) => `${change.path}\0${change.content}\0`).join(""));
  const reasons: string[] = [];
  try {
    await verifyContractLock();
  } catch (error) {
    return { accepted: false, candidateHash, reasons: [error instanceof Error ? error.message : "contract lock mismatch"] };
  }
  if (changes.length !== 1) return { accepted: false, candidateHash, reasons: ["candidate must change exactly one generated operation module"] };
  const change = changes[0]!;
  if (!allowedPath.test(change.path) || change.path.startsWith("generated/baseline/")) {
    return { accepted: false, candidateHash, reasons: [`path is outside repair scope: ${change.path}`] };
  }
  const variant = change.path.split("/")[1];
  if (variant === "rule-change") {
    return { accepted: false, candidateHash, reasons: ["rule-change requires a frozen contract revision; candidates are not promotable"] };
  }
  if (variant !== "candidate" && variant !== "locator-break") {
    return { accepted: false, candidateHash, reasons: [`candidate variant is outside the authorized repair scope: ${variant}`] };
  }
  const operation = change.path.split("/").at(-1)?.replace(/\.ts$/, "") as Operation | undefined;
  if (!operation) return { accepted: false, candidateHash, reasons: ["candidate operation path is invalid"] };

  if (operation !== "rename") {
    return { accepted: false, candidateHash, reasons: ["the frozen locator-break suite currently validates rename candidates only"] };
  }

  const candidatePath = resolve(packageRoot, change.path);
  await mkdir(dirname(candidatePath), { recursive: true });
  await writeFile(candidatePath, change.content);
  try {
    const module = await import(`${pathToFileURL(candidatePath).href}?candidate=${candidateHash}`);
    const accepted = await runFrozenCandidateSuite(module.rename);
    if (!accepted) reasons.push("human-authored candidate failed the frozen baseline/locator-break suite");
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : "candidate validation failed");
  } finally {
    await rm(candidatePath, { force: true });
  }
  return { accepted: reasons.length === 0, candidateHash, reasons };
}
