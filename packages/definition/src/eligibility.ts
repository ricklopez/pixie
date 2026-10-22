import { newDefinition } from "./validate.js";
import type { AutomationDefinition } from "./types.js";

/**
 * Reviewed definition for the synthetic eligibility-overview workflow. This is the reference contract the
 * acceptance tests use; the studio produces the same structure from a recording review.
 */
export function eligibilityOverviewDefinition(portalOrigin = "http://127.0.0.1:4174"): AutomationDefinition {
  const base = newDefinition({
    id: "eligibility-overview",
    name: "Eligibility overview",
    startUrl: `${portalOrigin}/demo-portal`,
    allowedOrigins: [portalOrigin]
  });
  return {
    ...base,
    keyFields: ["memberId"],
    adapterGenerator: "template",
    checkpoints: [
      {
        id: "search-form",
        objective: "On the member search page, enter the member ID {{memberId}} into the Member ID field and click Search.",
        precondition: [{ kind: "fieldVisible", label: "Member ID" }],
        postcondition: [{ kind: "urlMatches", pattern: "/demo-portal/members\\?" }, { kind: "labelPresent", label: "Eligibility status" }],
        allowedEffects: ["type", "click"],
        maxActions: 6
      },
      {
        id: "member-result",
        objective: "Open the benefits overview for the displayed member by clicking 'View benefits overview'.",
        precondition: [{ kind: "labelPresent", label: "Member ID" }],
        postcondition: [{ kind: "urlMatches", pattern: "/benefits$" }, { kind: "textPresent", text: "Benefits overview" }],
        allowedEffects: ["click"],
        maxActions: 4
      },
      {
        id: "benefits-overview",
        objective: "The benefits overview with the benefits table is visible. Nothing else to do.",
        precondition: [{ kind: "textPresent", text: "Benefits overview" }],
        postcondition: [{ kind: "textPresent", text: "Benefits" }],
        allowedEffects: [],
        maxActions: 1
      }
    ],
    inputs: [
      {
        name: "memberId",
        type: "string",
        required: true,
        description: "Synthetic member identifier, e.g. DEMO-1001",
        source: { kind: "caller" },
        binding: { checkpointId: "search-form", targetLabel: "Member ID" }
      }
    ],
    outputs: [
      { name: "memberId", type: "string", required: true, extractor: { kind: "labelValue", checkpointId: "benefits-overview", label: "Member ID" } },
      { name: "eligibilityStatus", type: "string", required: true, extractor: { kind: "labelValue", checkpointId: "benefits-overview", label: "Eligibility status" } },
      { name: "plan", type: "string", required: true, extractor: { kind: "labelValue", checkpointId: "benefits-overview", label: "Plan" } },
      { name: "effectiveFrom", type: "date", required: true, extractor: { kind: "labelValue", checkpointId: "benefits-overview", label: "Effective from" } },
      { name: "effectiveTo", type: "date", required: true, extractor: { kind: "labelValue", checkpointId: "benefits-overview", label: "Effective to" } },
      { name: "portalAsOf", type: "date", required: true, extractor: { kind: "labelValue", checkpointId: "benefits-overview", label: "Source date" } },
      { name: "annualMaximum", type: "number", required: true, extractor: { kind: "tableCell", checkpointId: "benefits-overview", table: "Benefits", rowLabel: "Annual maximum", column: "Amount", where: { column: "Network", equals: "In network" } } },
      { name: "annualMaximumRemaining", type: "number", required: true, extractor: { kind: "tableCell", checkpointId: "benefits-overview", table: "Benefits", rowLabel: "Annual maximum", column: "Remaining", where: { column: "Network", equals: "In network" } } },
      { name: "annualMaximumPeriod", type: "string", required: true, extractor: { kind: "tableCell", checkpointId: "benefits-overview", table: "Benefits", rowLabel: "Annual maximum", column: "Period", where: { column: "Network", equals: "In network" } } },
      { name: "deductible", type: "number", required: true, extractor: { kind: "tableCell", checkpointId: "benefits-overview", table: "Benefits", rowLabel: "Deductible", column: "Amount", where: { column: "Network", equals: "In network" } } },
      { name: "deductibleRemaining", type: "number", required: true, extractor: { kind: "tableCell", checkpointId: "benefits-overview", table: "Benefits", rowLabel: "Deductible", column: "Remaining", where: { column: "Network", equals: "In network" } } },
      { name: "deductibleNetwork", type: "string", required: true, extractor: { kind: "tableCell", checkpointId: "benefits-overview", table: "Benefits", rowLabel: "Deductible", column: "Network", where: { column: "Network", equals: "In network" } } },
      { name: "observedAt", type: "date", required: true, extractor: { kind: "observedAt" } }
    ],
    assertions: [
      { kind: "equalsInput", output: "memberId", input: "memberId" },
      { kind: "required", output: "eligibilityStatus" },
      { kind: "oneOf", output: "eligibilityStatus", values: ["Active", "Inactive", "Terminated"] },
      { kind: "dateNotAfter", earlier: "effectiveFrom", later: "effectiveTo" }
    ],
    authRequiredSignals: [{ kind: "urlMatches", pattern: "/demo-portal/login" }, { kind: "textPresent", text: "session has expired" }, { kind: "fieldVisible", label: "Password" }]
  };
}
