import type { AutomationDefinition } from "@gateway/definition";
import type { RecordedEvent, RecordingResult } from "@gateway/recorder";

export interface UnsupportedStep {
  seq: number;
  kind: string;
  reason: string;
}

export interface GeneratedAdapter {
  source: string;
  hash: string;
  unsupported: UnsupportedStep[];
  generator: "recorded";
  generatorVersion: string;
}

export interface AdapterRecording {
  events: RecordedEvent[];
  warnings?: unknown[];
  id?: string;
}

export type RecordingInput = AdapterRecording | RecordingResult;

export interface ScriptRunRequest {
  source: string;
  cdpUrl: string;
  input: Record<string, string | number | boolean>;
  startUrl: string;
  allowedOrigins: string[];
  maxActions: number;
  deadlineMs: number;
  outputPath?: string;
}

export interface ScriptRunResult {
  result?: unknown;
  error?: string;
  actions: number;
  providerCalls: 0;
  attemptedSecrets: boolean;
  finalUrl?: string;
}

export type { AutomationDefinition, RecordedEvent, RecordingResult };
