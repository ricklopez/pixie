import http from "node:http";
import https from "node:https";
import type { BrowserContext } from "playwright";

const modelHosts = new Set([
  "api.openai.com",
  "api.typesafe.ai",
  "api.anthropic.com",
  "generativelanguage.googleapis.com"
]);

export class ModelCallGuard {
  private attempts = 0;

  checkUrl(input: string | URL | Request): boolean {
    try {
      const url = input instanceof Request ? input.url : input.toString();
      if (!modelHosts.has(new URL(url).hostname.toLowerCase())) return false;
      this.attempts += 1;
      return true;
    } catch {
      return false;
    }
  }

  checkNodeArguments(arguments_: unknown[]): boolean {
    const first = arguments_[0];
    if ((first instanceof URL || typeof first === "string") && this.checkUrl(first)) return true;
    for (const argument of arguments_) {
      if (!argument || typeof argument !== "object") continue;
      const options = argument as { protocol?: string; hostname?: string; host?: string; path?: string };
      const host = options.hostname ?? options.host;
      if (!host) continue;
      try {
        if (this.checkUrl(`${options.protocol ?? "http:"}//${host}${options.path ?? "/"}`)) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  count(): number {
    return this.attempts;
  }
}

function isAllowedLocalUrl(input: string | URL | Request): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function isOffLoopbackNodeRequest(arguments_: unknown[]): boolean {
  const first = arguments_[0];
  try {
    let url: URL;
    if (first instanceof URL || typeof first === "string") {
      url = new URL(first.toString());
    } else if (first && typeof first === "object") {
      const options = first as { protocol?: string; hostname?: string; host?: string; port?: number; path?: string };
      const host = options.hostname ?? options.host;
      if (!host) return true;
      const port = options.port ? `:${options.port}` : "";
      url = new URL(`${options.protocol ?? "http:"}//${host}${port}${options.path ?? "/"}`);
    } else {
      return true;
    }
    if (!isAllowedLocalUrl(url)) return true;
    for (const argument of arguments_.slice(1)) {
      if (!argument || typeof argument !== "object") continue;
      const options = argument as { protocol?: string; hostname?: string; host?: string; port?: number; path?: string };
      const host = options.hostname ?? options.host;
      if (!host) continue;
      const port = options.port ? `:${options.port}` : "";
      if (!isAllowedLocalUrl(`${options.protocol ?? url.protocol}//${host}${port}${options.path ?? "/"}`)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function blockNodeRequests(guard: ModelCallGuard): () => void {
  const originalFetch = globalThis.fetch;
  const transports = [http, https].map((transport) => ({
    transport,
    request: transport.request,
    get: transport.get
  }));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (guard.checkUrl(input)) throw new Error("model host blocked by local experiment runner");
    if (!isAllowedLocalUrl(input)) throw new Error("off-loopback request blocked by local experiment runner");
    return originalFetch(input, init);
  }) as typeof fetch;
  for (const { transport } of transports) {
    const originalRequest = transport.request.bind(transport);
    transport.request = ((...args: Parameters<typeof transport.request>) => {
      if (guard.checkNodeArguments(args)) throw new Error("model host blocked by local experiment runner");
      if (isOffLoopbackNodeRequest(args)) throw new Error("off-loopback request blocked by local experiment runner");
      return Reflect.apply(originalRequest, transport, args);
    }) as typeof transport.request;
    const originalGet = transport.get.bind(transport);
    transport.get = ((...args: Parameters<typeof transport.get>) => {
      if (guard.checkNodeArguments(args)) throw new Error("model host blocked by local experiment runner");
      if (isOffLoopbackNodeRequest(args)) throw new Error("off-loopback request blocked by local experiment runner");
      return Reflect.apply(originalGet, transport, args);
    }) as typeof transport.get;
  }
  return () => {
    globalThis.fetch = originalFetch;
    for (const { transport, request, get } of transports) {
      transport.request = request;
      transport.get = get;
    }
  };
}

export async function installBrowserRequestGuard(
  context: BrowserContext,
  guard: ModelCallGuard,
  requestId: string,
  onWriteDispatch: () => void
): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (guard.checkUrl(url)) {
      await route.abort("blockedbyclient");
      return;
    }
    if (!isAllowedLocalUrl(url)) {
      await route.abort("blockedbyclient");
      return;
    }
    const method = route.request().method();
    if (url.pathname.startsWith("/__app/") && ["POST", "PATCH", "DELETE"].includes(method)) {
      onWriteDispatch();
      await route.continue({ headers: { ...route.request().headers(), "x-request-id": requestId } });
      return;
    }
    await route.continue();
  });
}
