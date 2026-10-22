import { sha256, canonicalJson } from "../shared/canonical.js";
import type { CapturedAction, LocatorCandidate, Operation, Trace } from "../shared/types.js";

export const GENERATOR_ID = "pixie-template-generator";
export const GENERATOR_VERSION = "1.0.0";

export class GeneratorGap extends Error {
  constructor(readonly operation: Operation, readonly actionIndex: number, message: string) {
    super(message);
    this.name = "GeneratorGap";
  }
}

function usableCandidates(candidate: LocatorCandidate, operation: Operation, actionIndex: number): LocatorCandidate {
  if (candidate.testid) return { testid: candidate.testid };
  if (candidate.role && candidate.accessibleName) {
    return { role: candidate.role, accessibleName: candidate.accessibleName };
  }
  if (candidate.label) return { label: candidate.label };
  if (candidate.text) return { text: candidate.text };
  if (candidate.cssPath) return { cssPath: candidate.cssPath };
  throw new GeneratorGap(operation, actionIndex, `action ${actionIndex} has no usable locator`);
}

function actionExpression(action: CapturedAction, candidate: LocatorCandidate): string {
  const locator = JSON.stringify(candidate);
  const scoped = action.scopeBinding
    ? `taskRow(page, args.${action.scopeBinding}!), ${locator}`
    : `page, ${locator}`;
  switch (action.kind) {
    case "fill":
      if (!action.inputBinding) throw new Error("fill action has no input binding");
      return `await (await locate(${scoped})).fill(args.${action.inputBinding}!);`;
    case "click":
      return `await (await locate(${scoped})).click();`;
    case "read-list":
      return "return await readVisibleTasks(page);";
  }
}

export function generateModule(trace: Trace): { source: string; traceHash: string; outputHash: string } {
  if (trace.demonstrationSource !== "synthetic-scripted") {
    throw new Error("only explicitly labeled synthetic-scripted traces are supported");
  }
  if (trace.actions.length === 0) throw new GeneratorGap(trace.operation, 0, "trace has no actions");
  const traceHash = sha256(canonicalJson(trace));
  const runtimeImports = trace.operation === "create"
    ? ["locate", "waitForTask"]
    : trace.operation === "list"
      ? ["readVisibleTasks"]
      : trace.operation === "rename"
        ? ["locate", "taskRow", "waitForTask"]
        : ["locate", "taskRow", "waitForTaskRemoval"];
  const functionName = trace.operation === "delete" ? "removeTask" : trace.operation;
  const lines = [
    `// ${GENERATOR_ID}@${GENERATOR_VERSION}`,
    `// trace-sha256: ${traceHash}`,
    `import { ${runtimeImports.join(", ")} } from "../../src/generator/runtime.js";`,
    'import type { Page } from "playwright";',
    'import type { GeneratedArgs, PublicTask } from "../../src/shared/types.js";',
    "",
    `export async function ${functionName}(page: Page, args: GeneratedArgs): Promise<PublicTask | PublicTask[] | undefined> {`
  ];
  trace.actions.forEach((action, index) => {
    const selected = usableCandidates(action.locatorCandidates[0] ?? {}, trace.operation, index);
    if (action.kind === "read-list") {
      lines.push(`  ${actionExpression(action, selected)}`);
      return;
    }
    lines.push(`  ${actionExpression(action, selected)}`);
  });
  if (trace.operation === "create") {
    lines.push("  return waitForTask(page, args.requestId!, args.title!);");
  } else if (trace.operation === "rename") {
    lines.push("  return waitForTask(page, args.requestId!, args.newTitle!, args.id!);");
  } else if (trace.operation === "delete") {
    lines.push("  await waitForTaskRemoval(page, args.id!);");
    lines.push("  return undefined;");
  }
  lines.push("}", "");
  if (trace.operation === "delete") lines.push("export { removeTask as delete };", "");
  const source = lines.join("\n");
  return { source, traceHash, outputHash: sha256(source) };
}

export function generateAll(traces: Trace[]): Record<Operation, ReturnType<typeof generateModule>> {
  const byOperation = new Map(traces.map((trace) => [trace.operation, generateModule(trace)]));
  const operations: Operation[] = ["create", "list", "rename", "delete"];
  for (const operation of operations) {
    if (!byOperation.has(operation)) throw new GeneratorGap(operation, 0, `missing ${operation} trace`);
  }
  return Object.fromEntries(operations.map((operation) => [operation, byOperation.get(operation)!])) as Record<
    Operation,
    ReturnType<typeof generateModule>
  >;
}
