import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { runScript } from "@gateway/adapter";
import type { AutomationDefinition, RawExtraction } from "@gateway/definition";
import type { RunRow } from "./db.js";

export const FIREWORKS_REPAIR_MODEL = "accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b";
export const FIREWORKS_REPAIR_PRICE_USD_PER_MILLION = { input: 0.05, output: 0.2 } as const;
export const FIREWORKS_REPAIR_PRICE_SOURCE = "https://docs.fireworks.ai/serverless/pricing (Nemotron Lightning 3.5 30B A3B)";
export const FIREWORKS_REPAIR_MODEL_SOURCE = "https://fireworks.ai/models/fireworks/nemotron-lightning-3p5-30b-a3b (serverless model page; coding/agentic capabilities)";
export const FIREWORKS_REPAIR_MODEL_CATALOG_SOURCE = "https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless=true";
export const FIREWORKS_MAX_CALLS = 3;
export const FIREWORKS_MAX_INPUT_TOKENS = 30_000;
export const FIREWORKS_MAX_OUTPUT_TOKENS = 4_000;

export function estimateRepairInputTokens(source: string, failureEvents: unknown[], domExcerpt: string): number {
  return Buffer.byteLength(JSON.stringify({ failingAdapterSource: source, failureEvents, domExcerpt }), "utf8") + 2048;
}

export function sanitizeRepairText(value: string, inputValues: string[]): string {
  let sanitized = value;
  for (const input of inputValues) {
    if (input.length >= 3) sanitized = sanitized.split(input).join("[REDACTED_INPUT]");
  }
  return sanitized
    .replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer [REDACTED]")
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)["']?[^&\s"'`,}]+["']?/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-|fw_)[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_SECRET]")
    .slice(0, 2400);
}

export function adapterSourceContainsSecret(source: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._-]{10,}|\b(?:sk-|fw_)[A-Za-z0-9_-]{10,}\b|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["'][^"']{8,}["']/i.test(source);
}

export interface RepairGate {
  name: "frozen_suite" | "replay" | "verifier";
  passed: boolean;
  log: string;
}

const root = resolve(import.meta.dirname ?? process.cwd(), "../../..");
const safeEnv = () => Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot"].flatMap((key) => process.env[key] ? [[key, process.env[key]!] as const] : []));

function processResult(args: string[], input?: string): Promise<{ code: number; log: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, { cwd: root, env: safeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (chunk) => (log += String(chunk)));
    child.stderr.on("data", (chunk) => (log += String(chunk)));
    child.on("error", (error) => resolveResult({ code: 1, log: error.message }));
    child.on("close", (code) => resolveResult({ code: code ?? 1, log }));
    child.stdin.end(input ?? "");
  });
}

export async function executeRepairGates(options: {
  source: string;
  definition: AutomationDefinition;
  run: RunRow;
  cdpUrl: string;
}): Promise<RepairGate[]> {
  const frozen = await processResult(["--import", "tsx", "--test", "experiments/001-todo/test/frozen/core.test.ts", "experiments/001-todo/test/frozen/repair.test.ts"]);
  const replay = await runScript({
    source: options.source,
    cdpUrl: options.cdpUrl,
    input: JSON.parse(options.run.input) as Record<string, string | number | boolean>,
    startUrl: options.definition.startUrl,
    allowedOrigins: options.definition.allowedOrigins,
    maxActions: options.definition.limits.maxActions,
    deadlineMs: options.definition.limits.deadlineMs
  });
  const replayLog = JSON.stringify(replay);
  const values = replay.result && typeof replay.result === "object" ? replay.result as Record<string, unknown> : {};
  const outputs: Record<string, RawExtraction> = {};
  for (const field of options.definition.outputs) {
    const value = values[field.name];
    outputs[field.name] = {
      value: (typeof value === "string" || Array.isArray(value) || value === null ? value : null) as RawExtraction["value"],
      checkpointId: "repair-replay",
      source: "repair replay"
    };
  }
  const verifier = await processResult(
    ["--import", "tsx", "apps/api/src/repair-verifier-child.ts"],
    JSON.stringify({ definition: options.definition, input: JSON.parse(options.run.input), extraction: outputs, observedAt: new Date().toISOString() })
  );
  let verified = false;
  try { verified = (JSON.parse(verifier.log) as { accepted?: boolean }).accepted === true; } catch { /* verifier process log records the failure */ }
  return [
    { name: "frozen_suite", passed: frozen.code === 0, log: frozen.log },
    { name: "replay", passed: !replay.error, log: replayLog },
    { name: "verifier", passed: verifier.code === 0 && verified, log: verifier.log }
  ];
}

export function sourceWithinAdapterScope(source: string): boolean {
  const withoutComments = source.replace(/\/\/[^\n]*/g, "");
  const imports = source.match(/^\s*import\b.*$/gm) ?? [];
  if (imports.length !== 1) return false;
  return /^\s*(?:\/\/[^\n]*\n|\s)*import\s+\{\s*(?:locate|checkpoint|extractOutputs)(?:\s*,\s*(?:locate|checkpoint|extractOutputs))*\s*\}\s+from\s+["']@gateway\/adapter\/runtime["'];[\s\S]*export\s+async\s+function\s+run\s*\(\s*page\s*,\s*input\s*\)\s*\{[\s\S]*\}\s*$/.test(source)
    && !/\b(?:checks|assertions|definition|verifyExtraction|frozen_suite|node:|process\.env|require\s*\(|eval\s*\(|fetch\s*\()\b/i.test(withoutComments);
}

export async function requestModelRepair(options: {
  source: string;
  failureEvents: unknown[];
  domExcerpt: string;
  apiKey: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  priorCalls?: number;
  priorInputTokens?: number;
  onUsage?: (usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }) => void;
}): Promise<{ source: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number }> {
  const calls = options.priorCalls ?? 0;
  const totalInputTokens = options.priorInputTokens ?? 0;
  if (calls >= FIREWORKS_MAX_CALLS) throw new Error("Fireworks repair call cap exceeded");
  const promptData = JSON.stringify({ failingAdapterSource: options.source, failureEvents: options.failureEvents, domExcerpt: options.domExcerpt });
  const inputTokens = estimateRepairInputTokens(options.source, options.failureEvents, options.domExcerpt);
  if (inputTokens > FIREWORKS_MAX_INPUT_TOKENS || totalInputTokens + inputTokens > FIREWORKS_MAX_INPUT_TOKENS) throw new Error("Fireworks repair input-token cap exceeded");
  const response = await (options.fetcher ?? fetch)(options.endpoint ?? "https://api.fireworks.ai/inference/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: FIREWORKS_REPAIR_MODEL,
      max_tokens: FIREWORKS_MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: "Return only adapter JavaScript source. Modify adapter behavior only; do not include markdown." },
        { role: "user", content: promptData }
      ]
    })
  });
  if (!response.ok) throw new Error(`Fireworks repair request failed with HTTP ${response.status}`);
  const body = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const source = body.choices?.[0]?.message?.content ?? "";
  const actualInput = body.usage?.prompt_tokens ?? inputTokens;
  const outputTokens = body.usage?.completion_tokens ?? Math.ceil(source.length / 3);
  const usage = {
    inputTokens: actualInput,
    outputTokens,
    estimatedCostUsd: (actualInput * FIREWORKS_REPAIR_PRICE_USD_PER_MILLION.input + outputTokens * FIREWORKS_REPAIR_PRICE_USD_PER_MILLION.output) / 1_000_000
  };
  options.onUsage?.(usage);
  if (actualInput > FIREWORKS_MAX_INPUT_TOKENS || outputTokens > FIREWORKS_MAX_OUTPUT_TOKENS) throw new Error("Fireworks usage exceeded configured repair caps");
  if (!sourceWithinAdapterScope(source)) throw new Error("Fireworks output is outside adapter-source scope");
  return { source, ...usage };
}
