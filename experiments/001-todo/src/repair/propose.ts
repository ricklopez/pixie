import type { Operation } from "../shared/types.js";

export interface RepairProposal {
  failedStep: string;
  sanitizedDomExcerpt: string;
  contract: unknown;
  allowedScope: string;
}

export function sanitizeDomExcerpt(html: string): string {
  return html
    .replace(/\svalue=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ' value="<redacted>"')
    .replace(/(authorization|token|password|secret)=([^&\s"'<>]+)/gi, "$1=<redacted>")
    .replace(/https?:\/\/[^"' <]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return "<redacted-url>";
      }
    })
    .slice(0, 2400);
}

export function proposeRepair(
  variant: "locator-break" | "candidate",
  operation: Operation,
  failedStep: string,
  domExcerpt: string,
  contract: unknown
): RepairProposal {
  return {
    failedStep: failedStep.slice(0, 500),
    sanitizedDomExcerpt: sanitizeDomExcerpt(domExcerpt),
    contract,
    allowedScope: `generated/${variant}/${operation}.ts`
  };
}
