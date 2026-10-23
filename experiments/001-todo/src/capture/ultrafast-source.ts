import type { Trace } from "../shared/types.js";

export interface UltrafastTraceSource {
  author(operation: string): Promise<Trace>;
}

export class OptInUltrafastSource implements UltrafastTraceSource {
  async author(_operation: string): Promise<Trace> {
    if (process.env.PIXIE_ALLOW_PAID_EXPERIMENT !== "1") {
      throw new Error("paid Ultrafast authoring is disabled; set PIXIE_ALLOW_PAID_EXPERIMENT=1 only with approval");
    }
    if (!process.env.TYPESAFE_API_KEY || !process.env.OPENAI_API_KEY) {
      throw new Error("paid Ultrafast authoring requires TYPESAFE_API_KEY and OPENAI_API_KEY");
    }
    throw new Error("paid Ultrafast authoring adapter is a non-executing opt-in stub");
  }
}
