import type { RepairProposal } from "./propose.js";

export interface RepairProvider {
  propose(proposal: RepairProposal): Promise<string>;
}

export class OptInPaidRepairProvider implements RepairProvider {
  async propose(_proposal: RepairProposal): Promise<string> {
    if (process.env.PIXIE_ALLOW_PAID_EXPERIMENT !== "1") {
      throw new Error("paid repair is disabled; set PIXIE_ALLOW_PAID_EXPERIMENT=1 only with approval");
    }
    if (!process.env.TYPESAFE_API_KEY || !process.env.OPENAI_API_KEY) {
      throw new Error("paid repair requires TYPESAFE_API_KEY and OPENAI_API_KEY");
    }
    throw new Error("paid repair provider is a non-executing opt-in stub");
  }
}
