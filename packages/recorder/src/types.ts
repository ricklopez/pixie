export type EventKind = "navigate" | "click" | "input" | "select" | "keypress" | "submit" | "unsupported";

/** Semantic description of an interacted element. Never includes entered values. */
export interface TargetDescriptor {
  tag: string;
  role: string | null;
  label: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  inputType: string | null;
  text: string | null;
  /** Ordered, code-owned locator hints (label/role/name/id). Not model-generated. */
  selectorHints: string[];
}

export interface RecordedEvent {
  seq: number;
  /** Milliseconds since recording start. */
  at: number;
  kind: EventKind;
  /** Sanitized URL: query values replaced with <redacted>. */
  url: string;
  target?: TargetDescriptor;
  /** For input/select events: whether a value was present and its length. The value itself is never stored. */
  hasValue?: boolean;
  valueLength?: number;
  /** For select events: the visible option label (not a typed secret). */
  optionLabel?: string;
  key?: string;
  /** For unsupported events: what was observed and why it will not replay. */
  reason?: string;
  frame?: "main" | "subframe";
}

export interface RecordingWarning {
  code: "subframe" | "popup" | "file-upload" | "unsupported-event" | "origin" | "capture-error";
  message: string;
  seq?: number;
}

export interface RecordingStatus {
  id: string;
  connected: boolean;
  startedAt: string;
  stoppedAt: string | null;
  elapsedMs: number;
  actionCount: number;
  warnings: RecordingWarning[];
  currentUrl: string | null;
  error: string | null;
}

export interface RecordingResult extends RecordingStatus {
  events: RecordedEvent[];
}

/** Raw event shape emitted by the injected page script. */
export interface RawPageEvent {
  kind: string;
  target?: Partial<TargetDescriptor>;
  hasValue?: boolean;
  valueLength?: number;
  optionLabel?: string;
  key?: string;
  reason?: string;
  url: string;
  isMainFrame: boolean;
}
