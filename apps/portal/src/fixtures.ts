/** Fictional members for the synthetic eligibility portal. No real plan, payer or patient data. */

export interface BenefitRow {
  benefit: string;
  period: string;
  network: string;
  amount: string;
  remaining: string;
}

export interface Member {
  memberId: string;
  name: string;
  eligibilityStatus: string;
  plan: string;
  effectiveFrom: string;
  effectiveTo: string;
  sourceDate: string;
  benefits: BenefitRow[];
  qualifications: string[];
}

/**
 * Search behaviour by memberId:
 *  DEMO-1001, DEMO-1002 - two valid members with different data
 *  DEMO-2001            - portal returns a different member's record (wrong-identity fixture)
 *  DEMO-3001            - incomplete result: blank status and no deductible rows
 *  anything else        - no member found
 */
export const MEMBERS: Record<string, Member> = {
  "DEMO-1001": {
    memberId: "DEMO-1001",
    name: "Avery Example",
    eligibilityStatus: "Active",
    plan: "Synthetic PPO Basic",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    sourceDate: "2026-09-25",
    benefits: [
      { benefit: "Annual maximum", period: "Calendar year", network: "In network", amount: "$1,500.00", remaining: "$1,120.00" },
      { benefit: "Annual maximum", period: "Calendar year", network: "Out of network", amount: "$1,000.00", remaining: "$1,000.00" },
      { benefit: "Deductible", period: "Calendar year", network: "In network", amount: "$50.00", remaining: "$0.00" },
      { benefit: "Deductible", period: "Calendar year", network: "Out of network", amount: "$100.00", remaining: "$100.00" }
    ],
    qualifications: ["Deductible waived for preventive services.", "Amounts shown are synthetic demonstration values."]
  },
  "DEMO-1002": {
    memberId: "DEMO-1002",
    name: "Blake Sample",
    eligibilityStatus: "Active",
    plan: "Synthetic HMO Plus",
    effectiveFrom: "2026-03-01",
    effectiveTo: "2027-02-28",
    sourceDate: "2026-09-24",
    benefits: [
      { benefit: "Annual maximum", period: "Plan year", network: "In network", amount: "$2,000.00", remaining: "$650.00" },
      { benefit: "Deductible", period: "Plan year", network: "In network", amount: "$75.00", remaining: "$25.00" }
    ],
    qualifications: ["Orthodontic lifetime maximum applies separately.", "Amounts shown are synthetic demonstration values."]
  },
  "DEMO-2002": {
    memberId: "DEMO-2002",
    name: "Casey Mismatch",
    eligibilityStatus: "Active",
    plan: "Synthetic PPO Basic",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    sourceDate: "2026-09-25",
    benefits: [
      { benefit: "Annual maximum", period: "Calendar year", network: "In network", amount: "$1,500.00", remaining: "$1,500.00" },
      { benefit: "Deductible", period: "Calendar year", network: "In network", amount: "$50.00", remaining: "$50.00" }
    ],
    qualifications: ["Amounts shown are synthetic demonstration values."]
  },
  "DEMO-3001": {
    memberId: "DEMO-3001",
    name: "Dana Partial",
    eligibilityStatus: "",
    plan: "Synthetic PPO Basic",
    effectiveFrom: "2026-01-01",
    effectiveTo: "",
    sourceDate: "2026-09-25",
    benefits: [
      { benefit: "Annual maximum", period: "Calendar year", network: "In network", amount: "$1,500.00", remaining: "$900.00" }
    ],
    qualifications: ["Deductible information is temporarily unavailable from the synthetic source."]
  }
};

/** Resolves a search to the record the portal would display, including the deliberate wrong-identity fixture. */
export function lookup(memberId: string): Member | undefined {
  const normalized = memberId.trim().toUpperCase();
  if (normalized === "DEMO-2001") return MEMBERS["DEMO-2002"];
  if (normalized === "DEMO-2002") return undefined;
  return MEMBERS[normalized];
}
