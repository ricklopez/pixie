import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { extractOutputs } from "../src/runtime.js";

const fixture = `
  <table>
    <tbody>
      <tr class="athing" id="story-123">
        <td class="title"><span class="rank">1.</span></td>
        <td class="title"><span class="titleline"><a href="https://example.test/story-123">First story</a></span></td>
      </tr>
      <tr class="athing" id="story-456">
        <td class="title"><span class="rank">2.</span></td>
        <td class="title"><span class="titleline"><a href="https://example.test/story-456">Second story</a></span></td>
      </tr>
    </tbody>
  </table>
`;

test("list extraction reads item attributes, selected attributes, and selected text", async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.GATEWAY_CHROME_PATH ?? process.env.CHROME_BIN ?? chromium.executablePath(),
    args: ["--no-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    const fields = {
      id: { attribute: "id" },
      rank: { selector: ".rank" },
      url: { selector: ".titleline > a", attribute: "href" }
    };
    const outputs = await extractOutputs(page, [
      { name: "stories", type: "list", required: true, extractor: { kind: "listItems", checkpointId: "front-page", list: "stories" } }
    ], {
      stories: { item: "tr.athing", text: ".titleline > a", fields }
    });
    assert.deepEqual(outputs.stories, [
      {
        text: "First story",
        completed: false,
        fields: { id: "story-123", rank: "1.", url: "https://example.test/story-123" }
      },
      {
        text: "Second story",
        completed: false,
        fields: { id: "story-456", rank: "2.", url: "https://example.test/story-456" }
      }
    ]);
    const legacy = await extractOutputs(page, [
      { name: "stories", type: "list", required: true, extractor: { kind: "listItems", checkpointId: "front-page", list: "stories" } }
    ], {
      stories: { item: "tr.athing", text: ".titleline > a" }
    });
    assert.deepEqual(legacy.stories, [
      { text: "First story", completed: false },
      { text: "Second story", completed: false }
    ]);
  } finally {
    await browser.close();
  }
});
