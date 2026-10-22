import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { cdpPortInUse, ensurePageTarget, launchControlledChrome, ownedPort, type ControlledChrome, type EndpointHealth } from "@gateway/recorder";

export interface BrowserPoolOptions {
  /** Parent directory; each profile lives in `<root>/<name>`. */
  root: string;
  /** First remote-debugging port to try; later profiles take the next free ports. */
  basePort: number;
  mode: "visible" | "headless";
  /**
   * When set, runs attach to this externally managed endpoint instead of launching Chrome. It is one shared
   * browser with no per-account isolation, so the pool only serves the first profile that asks for it and
   * refuses every other account/tenant (single-account dev mode).
   */
  fixedCdpUrl?: string;
  launch?: typeof launchControlledChrome;
  portInUse?: (port: number) => Promise<boolean>;
  /** Health probe for a browser this pool already launched; defaults to `ensurePageTarget`. */
  ensureUsable?: (cdpUrl: string) => Promise<EndpointHealth>;
  onRecovered?: (name: string, cdpUrl: string) => void;
}

/** Profile used by one tenant's Studio recording sessions; the leading underscore keeps it out of the account id space. */
export function recorderProfile(tenantId: string): string {
  if (!isValidAccountId(tenantId)) throw new Error(`invalid tenant id ${JSON.stringify(tenantId)}`);
  return `_recorder_${tenantId}`;
}
const RECORDER_PATTERN = /^_recorder_[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Account ids double as profile directory names, so they must be plain path segments. */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isValidAccountId(id: string): boolean {
  return ACCOUNT_ID_PATTERN.test(id);
}

/**
 * Directory name for a profile: the id for readability plus a digest of the exact id, so ids that differ only
 * by case (`acct_A` / `acct_a`) never share a directory on case-insensitive volumes such as default macOS APFS.
 */
export function profileDirName(name: string): string {
  if (!RECORDER_PATTERN.test(name) && !isValidAccountId(name)) throw new Error(`invalid browser profile name ${JSON.stringify(name)}`);
  return `${name}-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

/**
 * One dedicated Chrome per profile: a run for account A can only ever reach the profile at `<root>/<A>`, whose
 * localStorage/cookies are never shared with account B or with the developer's own browser. Profiles are
 * launched lazily and re-attached (never hijacked) after a gateway restart while the earlier Chrome still runs.
 */
export class BrowserPool {
  private readonly chromes = new Map<string, ControlledChrome>();
  private readonly pending = new Map<string, Promise<string>>();
  /** Ports handed to launches that have not finished yet (or are running); released if the launch fails. */
  private readonly reserved = new Set<number>();
  /** Serialises port selection so two concurrent first launches cannot pick the same port. */
  private allocating: Promise<unknown> = Promise.resolve();
  private fixedOwner: string | null = null;

  constructor(private readonly options: BrowserPoolOptions) {}

  profileDir(name: string): string {
    return resolve(this.options.root, profileDirName(name));
  }

  async cdpUrlFor(name: string): Promise<string> {
    const dir = profileDirName(name);
    if (this.options.fixedCdpUrl) {
      this.fixedOwner ??= name;
      if (this.fixedOwner !== name) {
        throw new Error(
          `GATEWAY_CDP_URL is a single shared browser already in use by profile ${JSON.stringify(this.fixedOwner)}; ` +
            `profile ${JSON.stringify(name)} refused to preserve account isolation (unset GATEWAY_CDP_URL for per-account browsers)`
        );
      }
      return this.options.fixedCdpUrl;
    }
    const existing = this.chromes.get(name);
    if (existing) {
      // Only browsers we launched are touched: a closed-last-tab Chrome gets a blank tab, a dead one is relaunched.
      const health = await (this.options.ensureUsable ?? ensurePageTarget)(existing.cdpUrl);
      if (health === "ready") return existing.cdpUrl;
      if (health === "recovered") {
        this.options.onRecovered?.(name, existing.cdpUrl);
        return existing.cdpUrl;
      }
      await existing.close().catch(() => {});
      this.chromes.delete(name);
      this.reserved.delete(Number(new URL(existing.cdpUrl).port));
    }
    let pending = this.pending.get(name);
    if (!pending) {
      pending = this.launch(name, dir).finally(() => this.pending.delete(name));
      this.pending.set(name, pending);
    }
    return pending;
  }

  private async launch(name: string, dir: string): Promise<string> {
    const userDataDir = resolve(this.options.root, dir);
    const launch = this.options.launch ?? launchControlledChrome;
    const port = await this.reservePort(userDataDir);
    try {
      const chrome = await launch({ port, userDataDir, mode: this.options.mode });
      this.chromes.set(name, chrome);
      return chrome.cdpUrl;
    } catch (error) {
      this.reserved.delete(port);
      throw error;
    }
  }

  private reservePort(userDataDir: string): Promise<number> {
    const next = this.allocating.then(async () => {
      const owned = ownedPort(userDataDir);
      const port = owned !== null && !this.reserved.has(owned) ? owned : await this.freePort();
      this.reserved.add(port);
      return port;
    });
    this.allocating = next.catch(() => undefined);
    return next;
  }

  private async freePort(): Promise<number> {
    const inUse = this.options.portInUse ?? cdpPortInUse;
    for (let port = this.options.basePort; port < this.options.basePort + 200; port += 1) {
      if (!this.reserved.has(port) && !(await inUse(port))) return port;
    }
    throw new Error(`no free remote-debugging port between ${this.options.basePort} and ${this.options.basePort + 200}`);
  }

  profiles(): { name: string; cdpUrl: string; userDataDir: string }[] {
    return [...this.chromes.entries()].map(([name, c]) => ({ name, cdpUrl: c.cdpUrl, userDataDir: this.profileDir(name) }));
  }

  async closeAll() {
    await Promise.all([...this.chromes.values()].map((c) => c.close()));
    this.chromes.clear();
    this.reserved.clear();
  }
}
