import { randomUUID } from "node:crypto";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { pageScriptSource } from "./page-script.js";
import { sanitizeEvent, sanitizeUrl } from "./sanitize.js";
import type { RawPageEvent, RecordedEvent, RecordingResult, RecordingStatus, RecordingWarning } from "./types.js";

export interface RecordingOptions {
  cdpUrl: string;
  startUrl: string;
  allowedOrigins: string[];
  /** Stream JPEG frames for the studio live view. */
  screencast?: boolean;
}

export type LiveInput =
  | { type: "mouse"; event: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button?: "left" | "none"; clickCount?: number }
  | { type: "key"; event: "keyDown" | "keyUp"; key: string; code?: string; text?: string }
  | { type: "insertText"; text: string }
  | { type: "wheel"; x: number; y: number; deltaY: number };

const VIEWPORT = { width: 1120, height: 780 };

/**
 * One controlled recording: an owned tab in the dedicated Chrome, injected capture script and a
 * bounded event buffer. Values entered by the developer are never captured.
 */
export class RecordingSession {
  readonly id = randomUUID();
  readonly startedAt = new Date();
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private events: RecordedEvent[] = [];
  private warnings: RecordingWarning[] = [];
  private seq = 0;
  private stoppedAt: Date | null = null;
  private error: string | null = null;
  private latestFrame: Buffer | null = null;
  private currentUrl: string | null = null;

  constructor(private readonly options: RecordingOptions) {}

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      // Close only what this session opened; pre-existing tabs in the dedicated Chrome are left alone.
      if (this.cdp) await this.cdp.send("Page.stopScreencast").catch(() => {});
      await this.cdp?.detach().catch(() => {});
      if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {});
      await this.browser?.close().catch(() => {});
      this.cdp = null;
      this.page = null;
      this.browser = null;
      throw error;
    }
  }

  private async connect(): Promise<void> {
    this.browser = await chromium.connectOverCDP(this.options.cdpUrl, { timeout: 15000 });
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    context.on("page", (popup) => {
      if (this.page && popup !== this.page) {
        this.record({ kind: "popup", url: popup.url(), isMainFrame: true, reason: "A new tab/pop-up opened; engine execution stays in the owned tab." }, "popup");
      }
    });
    const page = await context.newPage();
    this.page = page;
    await page.setViewportSize(VIEWPORT);
    await page.exposeBinding("__gatewayRecorderEvent", (_source, raw: RawPageEvent) => this.record(raw));
    await page.addInitScript({ content: pageScriptSource() });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      this.currentUrl = sanitizeUrl(url);
      this.push({ kind: "navigate", url, isMainFrame: true });
      if (!this.originAllowed(url)) {
        this.warnings.push({ code: "origin", seq: this.seq, message: `Navigated outside allowed origins: ${new URL(url).origin}` });
      }
    });
    page.on("close", () => {
      if (!this.stoppedAt) this.error = this.error ?? "Recorded tab was closed before stop.";
    });
    if (this.options.screencast) {
      this.cdp = await context.newCDPSession(page);
      this.cdp.on("Page.screencastFrame", (frame) => {
        this.latestFrame = Buffer.from(frame.data, "base64");
        this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      });
      await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
    }
    await page.goto(this.options.startUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  }

  private originAllowed(url: string): boolean {
    try {
      const origin = new URL(url).origin;
      return origin === "null" || this.options.allowedOrigins.includes(origin);
    } catch {
      return false;
    }
  }

  private record(raw: RawPageEvent, code?: RecordingWarning["code"]): void {
    if (this.stoppedAt) return;
    this.push(raw, code);
  }

  private push(raw: RawPageEvent, forceCode?: RecordingWarning["code"]): void {
    if (this.events.length >= 2000) {
      this.error = this.error ?? "Recording exceeded 2000 events; further events dropped.";
      return;
    }
    const seq = ++this.seq;
    const at = Date.now() - this.startedAt.getTime();
    const { event, warning } = sanitizeEvent(raw, seq, at);
    this.events.push(event);
    if (forceCode) this.warnings.push({ code: forceCode, seq, message: raw.reason ?? `Step ${seq}: ${raw.kind}` });
    else if (warning) this.warnings.push(warning);
  }

  status(): RecordingStatus {
    const end = this.stoppedAt ?? new Date();
    return {
      id: this.id,
      connected: Boolean(this.page && !this.page.isClosed() && this.browser?.isConnected()),
      startedAt: this.startedAt.toISOString(),
      stoppedAt: this.stoppedAt?.toISOString() ?? null,
      elapsedMs: end.getTime() - this.startedAt.getTime(),
      actionCount: this.events.filter((e) => e.kind !== "navigate").length,
      warnings: this.warnings,
      currentUrl: this.currentUrl,
      error: this.error
    };
  }

  frame(): Buffer | null {
    return this.latestFrame;
  }

  async input(input: LiveInput): Promise<void> {
    if (!this.cdp || this.stoppedAt) throw new Error("Recording is not accepting input");
    if (input.type === "mouse") {
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: input.event,
        x: input.x,
        y: input.y,
        button: input.button ?? (input.event === "mouseMoved" ? "none" : "left"),
        clickCount: input.clickCount ?? (input.event === "mouseMoved" ? 0 : 1)
      });
    } else if (input.type === "key") {
      const params: Record<string, unknown> = { type: input.event, key: input.key, code: input.code };
      if (input.event === "keyDown" && input.text) params.text = input.text;
      // Enter must be dispatched as a raw key so form submission fires.
      if (input.key === "Enter") Object.assign(params, { windowsVirtualKeyCode: 13, text: input.event === "keyDown" ? "\r" : undefined });
      if (input.key === "Tab") Object.assign(params, { windowsVirtualKeyCode: 9 });
      if (input.key === "Backspace") Object.assign(params, { windowsVirtualKeyCode: 8 });
      await this.cdp.send("Input.dispatchKeyEvent", params as never);
    } else if (input.type === "insertText") {
      await this.cdp.send("Input.insertText", { text: input.text });
    } else {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x, y: input.y, deltaX: 0, deltaY: input.deltaY });
    }
  }

  async stop(): Promise<RecordingResult> {
    if (this.stoppedAt) return { ...this.status(), events: this.events };
    // Let queued bindings flush before we close the tab.
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 60)));
      } catch (error) {
        this.error = this.error ?? `Flush failed: ${(error as Error).message}`;
      }
    }
    this.stoppedAt = new Date();
    try {
      if (this.cdp) await this.cdp.send("Page.stopScreencast").catch(() => {});
      if (this.page && !this.page.isClosed()) await this.page.close();
    } catch (error) {
      this.error = this.error ?? `Stop failed: ${(error as Error).message}`;
    } finally {
      // Disconnect only; the dedicated Chrome stays up for the engine worker.
      await this.browser?.close().catch(() => {});
      this.browser = null;
    }
    return { ...this.status(), events: this.events };
  }
}
