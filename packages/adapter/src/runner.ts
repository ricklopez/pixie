import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ScriptRunRequest, ScriptRunResult } from "./types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runScript(request: ScriptRunRequest): Promise<ScriptRunResult> {
  const dir = resolve(packageRoot, ".runs", `pixie-script-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const sourcePath = resolve(dir, "adapter.mjs");
  const outputPath = resolve(dir, "result.json");
  await writeFile(sourcePath, request.source, "utf8");
  const childPath = resolve(packageRoot, "dist/child.js");
  const args = process.env.NODE_ENV === "test" || childPath.endsWith(".ts")
    ? ["--import", "tsx", resolve(dirname(fileURLToPath(import.meta.url)), "child.ts")]
    : [childPath];
  args.push(sourcePath, JSON.stringify({
    allowedOrigins: request.allowedOrigins,
    startUrl: request.startUrl,
    maxActions: request.maxActions,
    deadlineMs: request.deadlineMs
  }));
  return await new Promise<ScriptRunResult>((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd: resolve(packageRoot, "../.."),
      env: {
        BU_CDP_URL: request.cdpUrl,
        PIXIE_SCRIPT_OUTPUT: outputPath,
        PIXIE_SCRIPT_INPUT: JSON.stringify(request.input)
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("exit", async () => {
      try {
        resolveResult(JSON.parse(await readFile(outputPath, "utf8")) as ScriptRunResult);
      } catch {
        resolveResult({ error: stderr.trim() || "script child exited without a result", actions: 0, providerCalls: 0, attemptedSecrets: false });
      }
    });
    child.on("error", (error) => resolveResult({ error: error.message, actions: 0, providerCalls: 0, attemptedSecrets: false }));
  });
}
