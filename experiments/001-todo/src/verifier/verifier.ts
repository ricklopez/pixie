import type { Operation, Task } from "../shared/types.js";
import { fetchHarnessState } from "../fixture/server.js";

export interface DeltaInput {
  op: Operation;
  before: Task[];
  after: Task[];
  input: Record<string, unknown>;
}

export interface DeltaVerification {
  accepted: boolean;
  reason: string | null;
  expectedDelta: number;
  actualDelta: number;
  preservedUnrelated: boolean;
}

export function verifyDelta({ op, before, after, input }: DeltaInput): DeltaVerification {
  const beforeById = new Map(before.map((task) => [task.id, task]));
  const afterById = new Map(after.map((task) => [task.id, task]));
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  let expectedDelta = op === "list" ? 0 : op === "delete" ? -1 : op === "create" ? 1 : 0;
  let actualDelta = after.length - before.length;
  let reason: string | null = null;
  const unrelatedIds = new Set(before.map((task) => task.id));

  if (op === "create") {
    const title = String(input.title ?? "");
    const matches = after.filter((task) => task.requestId === requestId && task.title === title && !beforeById.has(task.id));
    if (matches.length !== 1) reason = `expected one new row with requestId and title, found ${matches.length}`;
    else unrelatedIds.delete(matches[0]!.id);
  } else if (op === "rename") {
    const id = String(input.id ?? "");
    const old = beforeById.get(id);
    const current = afterById.get(id);
    if (!old || !current) reason = "rename target is missing before or after";
    else if (current.title !== input.newTitle || current.requestId !== requestId || current.done !== old.done) {
      reason = "rename target fields do not match the requested exact delta";
    }
    unrelatedIds.delete(id);
  } else if (op === "delete") {
    const id = String(input.id ?? "");
    if (!beforeById.has(id) || afterById.has(id)) reason = "delete target was not removed exactly";
    unrelatedIds.delete(id);
  }

  let preservedUnrelated = true;
  for (const id of unrelatedIds) {
    const old = beforeById.get(id);
    const current = afterById.get(id);
    if (JSON.stringify(old) !== JSON.stringify(current)) {
      preservedUnrelated = false;
      reason = reason ?? `unrelated row ${id} changed byte-for-byte`;
      break;
    }
  }

  if (op === "list" && JSON.stringify(before) !== JSON.stringify(after)) {
    reason = "list operation changed persisted state";
  }
  if (op === "create" && actualDelta !== 1) reason = reason ?? `create changed row count by ${actualDelta}`;
  if (op === "rename" && actualDelta !== 0) reason = reason ?? `rename changed row count by ${actualDelta}`;
  if (op === "delete" && actualDelta !== -1) reason = reason ?? `delete changed row count by ${actualDelta}`;

  return { accepted: reason === null, reason, expectedDelta, actualDelta, preservedUnrelated };
}

export async function verifyFixtureDelta(
  baseUrl: string,
  op: Operation,
  before: Task[],
  input: Record<string, unknown>
): Promise<{ after: Task[]; verification: DeltaVerification }> {
  const after = await fetchHarnessState(baseUrl);
  return { after, verification: verifyDelta({ op, before, after, input }) };
}
