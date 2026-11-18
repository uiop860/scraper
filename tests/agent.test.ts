import type { Spec } from "../extension/scraper/spec.ts";
import type {
  ResponseInputItem,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";
import { assert, expect, test } from "vitest";
import { parseHTML } from "linkedom";
import { generateScraper, testScraper } from "../extension/scraper/agent.ts";
import { extract } from "../extension/scraper/dom.ts";
const start = "https://market.test/list";
const spec = {
  version: 1,
  name: "Test",
  list: {
    itemSelector: "article",
    fields: {
      title: { selector: "h2", value: "text" },
      url: {
        selector: "a",
        value: "attribute",
        attribute: "href",
        resolveUrl: true,
      },
    },
  },
  detail: {
    linkField: "url",
    fields: { description: { selector: "p", value: "text" } },
  },
  pagination: { type: "next", selector: "a[rel=next]" },
} satisfies Spec;
function driver() {
  return {
    closed: 0,
    visits: [] as string[],
    inspections: [] as string[],
    async inspect(url: string) {
      this.inspections.push(url);
      return {
        url,
        title: "Shop",
        matches: 1,
        shadowRoots: [],
        truncated: false,
        samples: ["<article><h2>Desk</h2></article>"],
      };
    },
    async visit(url: string, kind: "list" | "detail", candidate: Spec) {
      this.visits.push(url);
      const html =
        kind === "detail"
          ? "<p>A useful desk</p>"
          : '<article><h2>Desk</h2><a href="/detail/1">View</a></article>' +
            (url === start ? '<a rel="next" href="/list?page=2">Next</a>' : "");
      return extract(parseHTML(html).document, candidate, kind, url);
    },
    async close() {
      this.closed++;
    },
  };
}
const call = (
  name: string,
  args: unknown,
  id = name,
): ResponseFunctionToolCall => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: id,
  id,
  status: "completed",
});
function toolOutput(input: ResponseInputItem[]) {
  const item = input.at(-1);
  assert.ok(item && item.type === "function_call_output");
  assert.strictEqual(typeof item.output, "string");
  return JSON.parse(item.output as string);
}
const args = (s = spec) => ({ spec: JSON.stringify(s) });
const inspection = call("inspect_page", { url: start, selector: "body" });
const signal = () => new AbortController().signal;
test("agent inspects, sees failed extraction, revises, tests detail and pagination, then returns exact JSON", async () => {
  const d = driver();
  const bad = structuredClone(spec);
  bad.list.fields.title.selector = ".missing";
  let turn = 0;
  const reasoning = {
    type: "reasoning" as const,
    id: "r1",
    summary: [],
    encrypted_content: "opaque",
  };
  const previews: Awaited<ReturnType<typeof testScraper>>[] = [];
  const updates: string[] = [];
  const traces: string[] = [];
  const result = await generateScraper(
    "Titles and descriptions across pages",
    start,
    d,
    async (input) => {
      turn++;
      if (turn === 1) return { text: "", output: [reasoning, inspection] };
      assert.deepStrictEqual(input[1], reasoning);
      if (turn === 2)
        return { text: "", output: [call("test_scraper", args(bad), "bad")] };
      if (turn === 3) {
        const output = toolOutput(input);
        assert.strictEqual(output.passed, false);
        assert.strictEqual(output.pages[0].diagnostics[0].code, "missing");
        return { text: "", output: [call("test_scraper", args(), "good")] };
      }
      const output = toolOutput(input);
      assert.strictEqual(output.passed, true);
      assert.strictEqual(
        output.pages[1].samples[0].description,
        "A useful desk",
      );
      assert.strictEqual(output.coverage.pagination, "tested next page");
      return { text: "", output: [call("finish_scraper", args())] };
    },
    signal(),
    (message) => updates.push(message),
    (event) => traces.push(event),
    (report) => previews.push(report),
  );
  assert.strictEqual(previews.length, 1);
  assert.strictEqual(previews[0]!.passed, true);
  assert.strictEqual(previews[0]!.pages[0]!.samples[0]!.title, "Desk");
  assert.strictEqual(
    previews[0]!.pages[1]!.samples[0]!.description,
    "A useful desk",
  );
  assert.ok(
    updates.some((message) => message.includes("Adjusting the selection")),
  );
  assert.ok(
    updates.every(
      (message) =>
        !/inspect_page|test_scraper|finish_scraper|Shadow DOM|diagnostics|HTML|nth-of-type/.test(
          message,
        ),
    ),
  );
  assert.ok(traces.includes("tool.result"));
  assert.deepStrictEqual(result, spec);
  assert.strictEqual(d.closed, 1);
  assert.strictEqual(d.visits.length, 6);
});
test("agent rejects untested finish and changed JSON even after a successful test", async () => {
  const d = driver();
  const changed = { ...spec, name: "Changed" };
  let turn = 0;
  await generateScraper(
    "titles",
    start,
    d,
    async (input) => {
      turn++;
      if (turn === 1)
        return { text: "", output: [call("finish_scraper", args())] };
      if (turn === 2) {
        assert.match(toolOutput(input).error, /successfully test/);
        return { text: "", output: [inspection, call("test_scraper", args())] };
      }
      if (turn === 3)
        return { text: "", output: [call("finish_scraper", args(changed))] };
      assert.match(toolOutput(input).error, /exact specification/);
      return { text: "", output: [call("finish_scraper", args())] };
    },
    signal(),
  );
  assert.strictEqual(d.closed, 1);
});
test("off-origin tools never reach the driver and malformed calls are returned as tool errors", async () => {
  const d = driver();
  let turn = 0;
  await expect(
    generateScraper(
      "titles",
      start,
      d,
      async (input) => {
        turn++;
        if (turn === 1)
          return {
            text: "",
            output: [
              call("inspect_page", {
                url: "https://evil.test",
                selector: "body",
              }),
            ],
          };
        if (turn === 2) {
          assert.match(toolOutput(input).error, /approved origin/);
          return {
            text: "",
            output: [call("test_scraper", { spec: "not JSON" })],
          };
        }
        assert.ok(toolOutput(input).error);
        return { output: [], text: "Cannot complete" };
      },
      signal(),
    ),
  ).rejects.toThrow(/finish a working sample/);
  assert.strictEqual(d.visits.length, 0);
  assert.strictEqual(d.inspections.length, 0);
  assert.strictEqual(d.closed, 1);
});
test("cancellation interrupts stalled model turns and closes the worker", async () => {
  const d = driver();
  const controller = new AbortController();
  const result = generateScraper(
    "titles",
    start,
    d,
    () => new Promise<never>(() => {}),
    controller.signal,
  );
  controller.abort();
  await expect(result).rejects.toThrow(/Cancelled/);
  assert.strictEqual(d.closed, 1);
});
test("tool-call limits stop runaway generation", async () => {
  const d = driver();
  await expect(
    generateScraper(
      "titles",
      start,
      d,
      async () => ({
        text: "",
        output: Array.from({ length: 25 }, (_, i) =>
          call("unknown", {}, String(i)),
        ),
      }),
      signal(),
    ),
  ).rejects.toThrow(/tool-call limit/);
  assert.strictEqual(d.closed, 1);
});
test("pagination without a next link is reported as unverified", async () => {
  const report = await testScraper(spec, `${start}?page=2`, driver(), signal());
  assert.strictEqual(report.passed, true);
  assert.match(report.coverage.pagination, /unverified/);
});
test("off-origin detail and pagination links cannot be tested", async () => {
  const d = driver();
  d.visit = async () => ({
    url: start,
    items: [{ url: "https://evil.test/detail" }],
    diagnostics: [],
    next: null,
  });
  await expect(testScraper(spec, start, d, signal())).rejects.toThrow(
    /approved origin/,
  );
});

test("inspection returns selector evidence while excluding form values, editable content and scripts", async () => {
  const { inspectPage } = await import("../extension/scraper/inspect.ts");
  const { document, Element, Node } = parseHTML(
    '<html><head><title>Shop</title></head><body><article data-testid="card" onclick="SECRET_HANDLER"><h2>Desk &amp; chair</h2><input value="SECRET_VALUE"><textarea>SECRET_TEXT</textarea><div contenteditable>SECRET_EDIT</div><script>SECRET_SCRIPT</script><a href="/detail/1">View</a></article></body></html>',
  );
  const names = ["document", "Element", "Node", "location"];
  const old = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  Object.assign(globalThis, {
    document,
    Element,
    Node,
    location: { href: start },
  });
  try {
    const result = inspectPage("article");
    assert.strictEqual(result.matches, 1);
    assert.strictEqual(result.title, "Shop");
    assert.match(result.samples[0]!, /data-testid="card"/);
    assert.match(result.samples[0]!, /Desk &amp; chair/);
    assert.match(result.samples[0]!, /href="\/detail\/1"/);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    document.body.innerHTML = "<article>Item</article>".repeat(500);
    const bounded = inspectPage("body");
    assert.strictEqual(bounded.truncated, true);
    assert.ok(bounded.samples[0]!.length < 40_000);
  } finally {
    names.forEach((name, i) => {
      if (old[i]) Object.defineProperty(globalThis, name, old[i]);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("a summary after a passing test requests submission and traces tools without reasoning", async () => {
  let round = 0;
  const events: unknown[] = [];
  const result = await generateScraper(
    "titles",
    start,
    driver(),
    async (input) => {
      round++;
      if (round === 1)
        return { text: "", output: [inspection, call("test_scraper", args())] };
      if (round === 2) return { text: "Configured and tested", output: [] };
      expect(JSON.stringify(input.at(-1))).toContain("finish_scraper");
      return { text: "", output: [call("finish_scraper", args())] };
    },
    signal(),
    () => {},
    (event, data) => events.push({ event, data }),
  );
  expect(result).toEqual(spec);
  expect(events).toContainEqual(
    expect.objectContaining({ event: "tool.result" }),
  );
  expect(events).toContainEqual({ event: "scraper.validated", data: spec });
});
