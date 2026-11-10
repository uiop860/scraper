import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { bundle } from "./helpers.mjs";
const { generateScraper, testScraper } = await import(
  await bundle("extension/scraper/agent.ts")
);
const { extract } = await import(await bundle("extension/scraper/dom.ts"));
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
};
function driver() {
  return {
    closed: 0,
    visits: [],
    inspections: [],
    async inspect(url) {
      this.inspections.push(url);
      return { url, samples: ["<article><h2>Desk</h2></article>"] };
    },
    async visit(url, kind, candidate) {
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
const call = (name, args, id = name) => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: id,
  id,
  status: "completed",
});
const args = (s = spec) => ({ spec: JSON.stringify(s) });
const inspection = call("inspect_page", { url: start, selector: "body" });
const signal = () => new AbortController().signal;
test("agent inspects, sees failed extraction, revises, tests detail and pagination, then returns exact JSON", async () => {
  const d = driver();
  const bad = structuredClone(spec);
  bad.list.fields.title.selector = ".missing";
  let turn = 0;
  const reasoning = {
    type: "reasoning",
    id: "r1",
    summary: [],
    encrypted_content: "opaque",
  };
  const result = await generateScraper(
    "Titles and descriptions across pages",
    start,
    d,
    async (input) => {
      turn++;
      if (turn === 1) return { output: [reasoning, inspection] };
      assert.deepEqual(input[1], reasoning);
      if (turn === 2)
        return { output: [call("test_scraper", args(bad), "bad")] };
      if (turn === 3) {
        const output = JSON.parse(input.at(-1).output);
        assert.equal(output.passed, false);
        assert.equal(output.pages[0].diagnostics[0].code, "missing");
        return { output: [call("test_scraper", args(), "good")] };
      }
      const output = JSON.parse(input.at(-1).output);
      assert.equal(output.passed, true);
      assert.equal(output.pages[1].samples[0].description, "A useful desk");
      assert.equal(output.coverage.pagination, "tested next page");
      return { output: [call("finish_scraper", args())] };
    },
    signal(),
  );
  assert.deepEqual(result, spec);
  assert.equal(d.closed, 1);
  assert.equal(d.visits.length, 6);
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
      if (turn === 1) return { output: [call("finish_scraper", args())] };
      if (turn === 2) {
        assert.match(
          JSON.parse(input.at(-1).output).error,
          /successfully test/,
        );
        return { output: [inspection, call("test_scraper", args())] };
      }
      if (turn === 3)
        return { output: [call("finish_scraper", args(changed))] };
      assert.match(
        JSON.parse(input.at(-1).output).error,
        /exact specification/,
      );
      return { output: [call("finish_scraper", args())] };
    },
    signal(),
  );
  assert.equal(d.closed, 1);
});
test("off-origin tools never reach the driver and malformed calls are returned as tool errors", async () => {
  const d = driver();
  let turn = 0;
  await assert.rejects(
    generateScraper(
      "titles",
      start,
      d,
      async (input) => {
        turn++;
        if (turn === 1)
          return {
            output: [
              call("inspect_page", {
                url: "https://evil.test",
                selector: "body",
              }),
            ],
          };
        if (turn === 2) {
          assert.match(
            JSON.parse(input.at(-1).output).error,
            /approved origin/,
          );
          return { output: [call("test_scraper", { spec: "not JSON" })] };
        }
        assert.ok(JSON.parse(input.at(-1).output).error);
        return { output: [], text: "Cannot complete" };
      },
      signal(),
    ),
    /Cannot complete/,
  );
  assert.equal(d.visits.length, 0);
  assert.equal(d.inspections.length, 0);
  assert.equal(d.closed, 1);
});
test("cancellation interrupts stalled model turns and closes the worker", async () => {
  const d = driver();
  const controller = new AbortController();
  const result = generateScraper(
    "titles",
    start,
    d,
    () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(result, /Cancelled/);
  assert.equal(d.closed, 1);
});
test("tool-call limits stop runaway generation", async () => {
  const d = driver();
  await assert.rejects(
    generateScraper(
      "titles",
      start,
      d,
      async () => ({
        output: Array.from({ length: 25 }, (_, i) =>
          call("unknown", {}, String(i)),
        ),
      }),
      signal(),
    ),
    /tool-call limit/,
  );
  assert.equal(d.closed, 1);
});
test("pagination without a next link is reported as unverified", async () => {
  const report = await testScraper(spec, `${start}?page=2`, driver(), signal());
  assert.equal(report.passed, true);
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
  await assert.rejects(
    testScraper(spec, start, d, signal()),
    /approved origin/,
  );
});

test("inspection returns selector evidence while excluding form values, editable content and scripts", async () => {
  const { inspectPage } = await import(
    await bundle("extension/scraper/inspect.ts")
  );
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
    assert.equal(result.matches, 1);
    assert.equal(result.title, "Shop");
    assert.match(result.samples[0], /data-testid="card"/);
    assert.match(result.samples[0], /Desk &amp; chair/);
    assert.match(result.samples[0], /href="\/detail\/1"/);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    document.body.innerHTML = "<article>Item</article>".repeat(500);
    const bounded = inspectPage("body");
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.samples[0].length < 40_000);
  } finally {
    names.forEach((name, i) => {
      if (old[i]) Object.defineProperty(globalThis, name, old[i]);
      else delete globalThis[name];
    });
  }
});
