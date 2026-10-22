import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ApprovalRecord {
  approver: string;
  time: string;
  candidateHash: string;
}

interface ActivePointer {
  activeHash: string;
  previousHash: string | null;
}

export class PromotionStore {
  private readonly activePath: string;
  private readonly logPath: string;

  constructor(private readonly directory: string) {
    this.activePath = join(directory, "active.json");
    this.logPath = join(directory, "promotions.log");
  }

  async initialize(activeHash: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      await readFile(this.activePath, "utf8");
    } catch {
      await writeFile(this.activePath, `${JSON.stringify({ activeHash, previousHash: null }, null, 2)}\n`);
    }
    try {
      await readFile(this.logPath, "utf8");
    } catch {
      await writeFile(this.logPath, "");
    }
  }

  async active(): Promise<ActivePointer> {
    return JSON.parse(await readFile(this.activePath, "utf8")) as ActivePointer;
  }

  async promote(
    candidateHash: string,
    approval: ApprovalRecord | undefined,
    validation: { accepted: boolean; candidateHash: string } | undefined
  ): Promise<ActivePointer> {
    if (!validation?.accepted || validation.candidateHash !== candidateHash) {
      throw new Error("promotion requires a validated candidate with the same hash");
    }
    if (!approval || !approval.approver.trim() || Number.isNaN(Date.parse(approval.time)) || approval.candidateHash !== candidateHash) {
      throw new Error("promotion requires a valid approval record for this candidate hash");
    }
    const previous = await this.active();
    const next = { activeHash: candidateHash, previousHash: previous.activeHash };
    await appendFile(this.logPath, `${JSON.stringify({ type: "promote", ...approval, previousHash: previous.activeHash })}\n`);
    await writeFile(this.activePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  async rollback(approver: string): Promise<ActivePointer> {
    if (!approver.trim()) throw new Error("rollback requires an approver");
    const current = await this.active();
    if (!current.previousHash) throw new Error("no previous hash is available for rollback");
    const next = { activeHash: current.previousHash, previousHash: null };
    await appendFile(this.logPath, `${JSON.stringify({
      type: "rollback",
      approver,
      time: new Date().toISOString(),
      fromHash: current.activeHash,
      toHash: current.previousHash
    })}\n`);
    await writeFile(this.activePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
