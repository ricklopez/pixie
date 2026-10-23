export const SCHEMA_VERSION = "gateway.automation/v1";
export const ENGINE = "jev-ultrafast";
/** Pinned upstream revision of browser-use/jev-ultrafast used by the worker. */
export const ENGINE_REVISION = "1231850a0bf1a0c0341fe408ef1668dbbfdfac46";

export type FieldType = "string" | "number" | "boolean" | "date" | "list";
export const FIELD_TYPES: readonly FieldType[] = ["string", "number", "boolean", "date", "list"];
/** Types a caller may supply as input; `list` is output-only. */
export const INPUT_FIELD_TYPES: readonly FieldType[] = ["string", "number", "boolean", "date"];

/** `read` automations never change site state; `write` automations declare checkpoint mutations that are verified. */
export type Effect = "read" | "write";
export type ActionEffect = "click" | "type" | "select" | "navigate";
export type AdapterGenerator = "template" | "recorded" | "manual";

/** Where an input value comes from at run time. Secret references are resolved server-side; values are never stored in definitions. */
export type InputSource = { kind: "caller" } | { kind: "accountSecret"; secretRef: string };

export interface InputBinding {
  checkpointId: string;
  /** Confirmed semantic label of the field the value is typed into. Matched against observed elements, never a selector. */
  targetLabel: string;
  /** Recording event this binding was confirmed from, for traceability. */
  eventSeq?: number;
}

export interface InputField {
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
  source: InputSource;
  binding: InputBinding;
}

export type Extractor =
  | { kind: "labelValue"; checkpointId: string; label: string }
  | { kind: "tableCell"; checkpointId: string; table: string; rowLabel: string; column: string; where?: { column: string; equals: string } }
  | { kind: "listItems"; checkpointId: string; list: string }
  | { kind: "observedAt" };

/**
 * Reviewed description of a repeated list on the page. Selectors are confirmed by the developer during review
 * and are only used to read the list (extraction, conditions, mutation verification), never to pick actions.
 */
export interface ListSpec {
  /** CSS selector of one visible list item. */
  item: string;
  /** CSS selector, relative to the item, of the element whose text identifies the item. */
  text: string;
  /** Optional CSS selector, relative to the item, that matches only when the item is marked completed. */
  completed?: string;
}

/**
 * Accessibility shim applied to the live page before every observation: unlabeled site controls (plain divs
 * with click handlers) are exposed to the engine as labeled roles so it can choose them as observed actions.
 * `{{text}}` in the label is replaced with the enclosing list item's text so each control names its item.
 * `activate: "dblclick"` forwards a single click to the element's own dblclick handler (the site's edit
 * gesture); nothing else about the page is changed and site storage is never touched.
 */
export interface Affordance {
  selector: string;
  role: "button" | "textbox";
  label: string;
  /** Selector of the ancestor list item whose text fills `{{text}}`. */
  item?: string;
  /** Selector, relative to `item`, of the element whose text fills `{{text}}`; defaults to the item itself. */
  itemText?: string;
  activate?: "click" | "dblclick";
}

/** A write checkpoint declares the exact list change it must produce; the worker verifies it from DOM before/after. */
export interface Mutation {
  kind: "create" | "update" | "delete";
  list: string;
  /** Template naming the existing item (update/delete), e.g. "{{title}}". */
  target?: string;
  /** Template for the created or new value (create/update), e.g. "{{newTitle}}". */
  value?: string;
  /** Items outside this prefix are never targeted or created (demo safety scope). */
  requirePrefix?: string;
  /** Id of an earlier checkpoint at whose start the pre-write snapshot and guard run; defaults to the owning checkpoint. */
  guardAt?: string;
}

export interface OutputField {
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
  extractor: Extractor;
}

export type Condition =
  | { kind: "urlMatches"; pattern: string }
  | { kind: "textPresent"; text: string }
  | { kind: "labelPresent"; label: string }
  | { kind: "fieldVisible"; label: string }
  | { kind: "fieldValue"; label: string; text: string }
  | { kind: "itemPresent"; list: string; text: string }
  | { kind: "itemAbsent"; list: string; text: string };

export interface Checkpoint {
  id: string;
  /** Reviewed objective handed to the engine for this segment. Inputs are referenced as {{name}} and substituted by the worker. */
  objective: string;
  precondition: Condition[];
  postcondition: Condition[];
  allowedEffects: ActionEffect[];
  maxActions: number;
  mutation?: Mutation;
}

export type Assertion =
  | { kind: "equalsInput"; output: string; input: string }
  | { kind: "required"; output: string }
  | { kind: "oneOf"; output: string; values: string[] }
  | { kind: "dateNotAfter"; earlier: string; later: string }
  /** A list output contains exactly one item whose text equals the input. */
  | { kind: "listContainsInput"; output: string; input: string }
  /** A list output contains no item whose text equals the input. */
  | { kind: "listExcludesInput"; output: string; input: string };

export interface Limits {
  maxActions: number;
  deadlineMs: number;
}

export interface AutomationDefinition {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  repository?: string;
  method?: string;
  /** Stable output fields or list-item text paths, such as `tasks.text`. */
  keyFields?: string[];
  adapterGenerator?: AdapterGenerator;
  engine: typeof ENGINE;
  engineRevision: string;
  startUrl: string;
  allowedOrigins: string[];
  effect: Effect;
  inputs: InputField[];
  outputs: OutputField[];
  checkpoints: Checkpoint[];
  assertions: Assertion[];
  limits: Limits;
  lists?: Record<string, ListSpec>;
  affordances?: Affordance[];
  /** Opaque recording id the definition was reviewed from; the recording itself is stored separately. */
  sourceRecordingId?: string;
  /** Detected during login-state detection: URL pattern or text that marks an expired session. */
  authRequiredSignals: Condition[];
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}
