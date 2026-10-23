import { newDefinition } from "./validate.js";
import type { AutomationDefinition, ListSpec } from "./types.js";

export const HN_ORIGIN = "https://news.ycombinator.com";

const stories: ListSpec = {
  item: "tr.athing",
  text: ".titleline > a",
  fields: {
    id: { attribute: "id" },
    rank: { selector: ".rank" },
    url: { selector: ".titleline > a", attribute: "href" }
  }
};

export function hackerNewsFrontPageDefinition(origin = HN_ORIGIN): AutomationDefinition {
  return {
    ...newDefinition({
      id: "hn-front-page",
      name: "Hacker News front page",
      startUrl: `${origin}/news`,
      allowedOrigins: [origin]
    }),
    keyFields: ["stories.fields.id"],
    adapterGenerator: "template",
    effect: "read",
    checkpoints: [{
      id: "front-page",
      objective: "The Hacker News front page story list is visible. Nothing else to do.",
      precondition: [{ kind: "textPresent", text: "Hacker News" }],
      postcondition: [{ kind: "urlMatches", pattern: "^https://news\\.ycombinator\\.com/" }],
      allowedEffects: [],
      maxActions: 1
    }],
    inputs: [],
    outputs: [
      {
        name: "stories",
        type: "list",
        required: true,
        description: "Hacker News front-page stories",
        extractor: { kind: "listItems", checkpointId: "front-page", list: "stories" }
      },
      { name: "observedAt", type: "date", required: true, extractor: { kind: "observedAt" } }
    ],
    lists: { stories },
    assertions: [
      { kind: "listMinItems", output: "stories", min: 10 },
      { kind: "listUniqueField", output: "stories", field: "id" }
    ],
    authRequiredSignals: [],
    limits: { maxActions: 2, deadlineMs: 60_000 }
  };
}
