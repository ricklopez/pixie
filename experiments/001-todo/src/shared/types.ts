import type { Page } from "playwright";

export const TODO_PREFIX = "pixie-demo ";
export const OPERATIONS = ["create", "list", "rename", "delete"] as const;
export type Operation = (typeof OPERATIONS)[number];
export type Variant = "baseline" | "cosmetic" | "locator-break" | "ambiguous" | "rule-change";

export interface Task {
  id: string;
  title: string;
  done: boolean;
  requestId: string | null;
}

export interface PublicTask {
  id: string;
  title: string;
  done: boolean;
}

export interface WriteInput {
  requestId: string;
}

export type OperationInput =
  | { op: "create"; input: { title: string; requestId: string } }
  | { op: "list"; input: Record<string, never> }
  | { op: "rename"; input: { id: string; newTitle: string; requestId: string } }
  | { op: "delete"; input: { id: string; requestId: string } };

export type TerminalState =
  | "completed"
  | "needs_review"
  | "outcome_unknown"
  | "conflict"
  | "rejected"
  | "contract_revision_required"
  | "failed";

export type LedgerState =
  | "intent_recorded"
  | "dispatched"
  | "confirmed"
  | "outcome_unknown"
  | "reconciled_existing"
  | "needs_review";

export interface RunResult {
  terminal: TerminalState;
  op: Operation;
  result?: PublicTask | PublicTask[];
  error?: string;
  reused: boolean;
  dispatchCount: number;
  modelCallAttempts: number;
  ledgerState?: LedgerState;
}

export interface LocatorCandidate {
  testid?: string;
  role?: string;
  accessibleName?: string;
  label?: string;
  text?: string;
  cssPath?: string;
}

export type CapturedActionKind = "fill" | "click" | "read-list";

export interface CapturedAction {
  kind: CapturedActionKind;
  inputBinding?: string;
  scopeBinding?: string;
  locatorCandidates: LocatorCandidate[];
  urlBefore: string;
  urlAfter: string;
  sanitized: true;
}

export interface Trace {
  traceVersion: 1;
  operation: Operation;
  demonstrationSource: "synthetic-scripted";
  inputs: string[];
  actions: CapturedAction[];
  versions: {
    capture: string;
    playwright: string;
    chromium: string;
  };
}

export interface GeneratedArgs {
  title?: string;
  id?: string;
  newTitle?: string;
  requestId?: string;
}

export interface GeneratedOperation {
  (page: Page, args: GeneratedArgs): Promise<PublicTask | PublicTask[] | undefined>;
}
