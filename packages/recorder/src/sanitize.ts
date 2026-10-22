import type { RawPageEvent, RecordedEvent, RecordingWarning, TargetDescriptor } from "./types.js";

const MAX_TEXT = 80;

/** Replace every query value and fragment with a placeholder so demonstration inputs never persist in URLs. */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const keys = [...new Set([...url.searchParams.keys()])];
    url.search = "";
    url.hash = "";
    if (keys.length) url.search = "?" + keys.map((k) => `${encodeURIComponent(k)}=%3Credacted%3E`).join("&");
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "about:invalid";
  }
}

export function sanitizeTarget(target: Partial<TargetDescriptor> | undefined): TargetDescriptor | undefined {
  if (!target) return undefined;
  const clip = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);
  const inputType = clip(target.inputType);
  const isSecret = inputType === "password";
  const hints = Array.isArray(target.selectorHints) ? target.selectorHints.filter((h) => typeof h === "string").slice(0, 6) : [];
  return {
    tag: (clip(target.tag) ?? "UNKNOWN").toUpperCase(),
    role: clip(target.role),
    label: clip(target.label),
    name: clip(target.name),
    id: clip(target.id),
    placeholder: clip(target.placeholder),
    inputType,
    // Text content of a password field or its neighbours is not needed and could echo a value.
    text: isSecret ? null : clip(target.text),
    selectorHints: hints
  };
}

const SUPPORTED = new Set(["click", "input", "select", "keypress", "submit", "navigate"]);

export interface SanitizedEvent {
  event: RecordedEvent;
  warning?: RecordingWarning;
}

export function sanitizeEvent(raw: RawPageEvent, seq: number, at: number): SanitizedEvent {
  const url = sanitizeUrl(raw.url);
  const target = sanitizeTarget(raw.target);
  const frame: "main" | "subframe" = raw.isMainFrame ? "main" : "subframe";
  const base: RecordedEvent = { seq, at, kind: "unsupported", url, frame };

  if (!raw.isMainFrame) {
    return {
      event: { ...base, target, reason: "Action inside a subframe is captured but not replayable by the engine." },
      warning: { code: "subframe", seq, message: `Step ${seq}: action inside a subframe was recorded as unsupported.` }
    };
  }
  if (target?.inputType === "file") {
    return {
      event: { ...base, target, reason: "File uploads are not supported by the engine." },
      warning: { code: "file-upload", seq, message: `Step ${seq}: file upload is not supported.` }
    };
  }
  if (!SUPPORTED.has(raw.kind)) {
    return {
      event: { ...base, target, reason: raw.reason ?? `Event '${raw.kind}' is not a supported replay action.` },
      warning: { code: "unsupported-event", seq, message: `Step ${seq}: '${raw.kind}' is not supported and will not replay.` }
    };
  }
  const event: RecordedEvent = { ...base, kind: raw.kind as RecordedEvent["kind"], target };
  if (raw.kind === "input" || raw.kind === "select") {
    event.hasValue = Boolean(raw.hasValue);
    event.valueLength = typeof raw.valueLength === "number" ? raw.valueLength : 0;
    if (raw.kind === "select" && typeof raw.optionLabel === "string") event.optionLabel = raw.optionLabel.slice(0, MAX_TEXT);
  }
  if (raw.kind === "keypress") event.key = typeof raw.key === "string" ? raw.key.slice(0, 20) : undefined;
  return { event };
}
