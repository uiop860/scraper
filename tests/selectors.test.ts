import { assert, expect, test } from "vitest";
import { parseHTML } from "linkedom";
const { queryElements, selectorParts, validateSelector, shadowContexts } =
  await import("../extension/scraper/selectors.ts");
import { extract, waitForDom } from "../extension/scraper/dom.ts";
import { parseSpec } from "../extension/scraper/spec.ts";
import { runScraper } from "../extension/scraper/runner.ts";
import { dbaListings } from "../extension/scraper/dba.ts";

function fixture() {
  const { document } = parseHTML(
    "<body><podium-layout></podium-layout></body>",
  );
  const root = document
    .querySelector("podium-layout")!
    .attachShadow({ mode: "open" });
  root.innerHTML =
    '<main><section data-testid="description"><div class="whitespace-pre-wrap">Complete listing description</div></section><inner-card></inner-card></main>';
  root.querySelector("inner-card")!.attachShadow({ mode: "open" }).innerHTML =
    "<b>Nested content</b>";
  return { document, root };
}
test("shadow selectors cross only explicit open boundaries and preserve quoted CSS", () => {
  const { document } = fixture();
  assert.strictEqual(
    queryElements(document, '[data-testid="description"]').length,
    0,
  );
  assert.strictEqual(
    queryElements(document, 'podium-layout >>> [data-testid="description"]')
      .length,
    1,
  );
  assert.strictEqual(
    queryElements(document, "podium-layout >>> inner-card >>> b")[0]!
      .textContent,
    "Nested content",
  );
  assert.deepStrictEqual(selectorParts('[data-label="a >>> b"] >>> p'), [
    '[data-label="a >>> b"]',
    "p",
  ]);
  validateSelector('podium-layout >>> [data-testid="description"]', document);
  assert.throws(() => validateSelector("missing-host >>> [", document));
  assert.throws(() => selectorParts("host >>> "));
  const contexts = shadowContexts(document);
  assert.strictEqual(contexts.length, 2);
  for (const { prefix } of contexts)
    assert.ok(queryElements(document, `${prefix}*`).length);
});
test("DBA preset visits every listing and extracts descriptions inside its layout shadow root", async () => {
  const doc = parseHTML(
    '<main><article class="sf-search-ad"><h2>One</h2><a class="sf-search-ad-link" href="/item/1"></a></article><article class="sf-search-ad"><h2>Two</h2><a class="sf-search-ad-link" href="/item/2"></a></article></main>',
  ).document;
  const visits = [];
  const spec = parseSpec(dbaListings, (selector) =>
    validateSelector(selector, doc),
  );
  const result = await runScraper(
    spec,
    "https://www.dba.dk/search",
    {
      async visit(url, kind, candidate) {
        visits.push(url);
        return extract(
          kind === "list" ? doc : fixture().document,
          candidate,
          kind,
          url,
        );
      },
      async close() {},
    },
    new AbortController().signal,
  );
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(visits.length, 3);
  assert.deepStrictEqual(
    result.items.map((item) => item.detail!.description),
    ["Complete listing description", "Complete listing description"],
  );
  assert.strictEqual(result.diagnostics.length, 0);
});
test("readiness detects delayed shadow attachment and later mutations inside its root", async () => {
  const { document } = parseHTML(
    "<body><podium-layout></podium-layout><aside></aside></body>",
  );
  const ready = waitForDom(
    document,
    "podium-layout >>> .description",
    new AbortController().signal,
    1000,
    40,
  );
  const inserted = setTimeout(() => {
    const root = document
      .querySelector("podium-layout")!
      .attachShadow({ mode: "open" });
    root.innerHTML = '<p class="description">Loading</p>';
    setTimeout(() => {
      root.querySelector("p")!.textContent = "Full description";
    }, 30);
  }, 120);
  const unrelated = setInterval(() => {
    document.querySelector("aside")!.textContent = String(Date.now());
  }, 10);
  try {
    await ready;
    assert.strictEqual(
      queryElements(document, "podium-layout >>> .description")[0]!.textContent,
      "Full description",
    );
  } finally {
    clearTimeout(inserted);
    clearInterval(unrelated);
  }
});
test("shadow readiness cancels and closed roots stay inaccessible", async () => {
  const { document } = parseHTML(
    "<body><private-layout></private-layout></body>",
  );
  document
    .querySelector("private-layout")!
    .attachShadow({ mode: "closed" }).innerHTML = "<p>Private</p>";
  assert.strictEqual(queryElements(document, "private-layout >>> p").length, 0);
  const controller = new AbortController();
  const ready = waitForDom(
    document,
    "private-layout >>> p",
    controller.signal,
    1000,
    5,
  );
  controller.abort();
  await expect(ready).rejects.toThrow(/Cancelled/);
});

test("deep text selectors stay bounded and resolve to their original element", async () => {
  const { elementSelector } = await import("../extension/scraper/selectors");
  const { document } = parseHTML(
    '<html><body><main role="main">' +
      "<div>".repeat(25) +
      '<span dir="auto">Listing description</span>' +
      "</div>".repeat(25) +
      "</main></body></html>",
  );
  const node = document.querySelector("span")!;
  const selector = elementSelector(node);
  expect(selector.length).toBeLessThan(500);
  expect(queryElements(document, selector)).toEqual([node]);
});
