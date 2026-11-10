import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { bundle } from "./helpers.mjs";
const { queryElements, selectorParts, validateSelector, shadowContexts } =
  await import(await bundle("extension/scraper/selectors.ts"));
const { extract, waitForDom } = await import(
  await bundle("extension/scraper/dom.ts")
);
const { parseSpec } = await import(await bundle("extension/scraper/spec.ts"));
const { runScraper } = await import(
  await bundle("extension/scraper/runner.ts")
);
const { dbaListings } = await import(await bundle("extension/scraper/dba.ts"));

function fixture() {
  const { document } = parseHTML(
    "<body><podium-layout></podium-layout></body>",
  );
  const root = document
    .querySelector("podium-layout")
    .attachShadow({ mode: "open" });
  root.innerHTML =
    '<main><section data-testid="description"><div class="whitespace-pre-wrap">Complete listing description</div></section><inner-card></inner-card></main>';
  root.querySelector("inner-card").attachShadow({ mode: "open" }).innerHTML =
    "<b>Nested content</b>";
  return { document, root };
}
test("shadow selectors cross only explicit open boundaries and preserve quoted CSS", () => {
  const { document } = fixture();
  assert.equal(
    queryElements(document, '[data-testid="description"]').length,
    0,
  );
  assert.equal(
    queryElements(document, 'podium-layout >>> [data-testid="description"]')
      .length,
    1,
  );
  assert.equal(
    queryElements(document, "podium-layout >>> inner-card >>> b")[0]
      .textContent,
    "Nested content",
  );
  assert.deepEqual(selectorParts('[data-label="a >>> b"] >>> p'), [
    '[data-label="a >>> b"]',
    "p",
  ]);
  validateSelector('podium-layout >>> [data-testid="description"]', document);
  assert.throws(() => validateSelector("missing-host >>> [", document));
  assert.throws(() => selectorParts("host >>> "));
  const contexts = shadowContexts(document);
  assert.equal(contexts.length, 2);
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
  assert.equal(result.status, "completed");
  assert.equal(result.items.length, 2);
  assert.equal(visits.length, 3);
  assert.deepEqual(
    result.items.map((item) => item.detail.description),
    ["Complete listing description", "Complete listing description"],
  );
  assert.equal(result.diagnostics.length, 0);
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
      .querySelector("podium-layout")
      .attachShadow({ mode: "open" });
    root.innerHTML = '<p class="description">Loading</p>';
    setTimeout(() => {
      root.querySelector("p").textContent = "Full description";
    }, 30);
  }, 120);
  const unrelated = setInterval(() => {
    document.querySelector("aside").textContent = String(Date.now());
  }, 10);
  try {
    await ready;
    assert.equal(
      queryElements(document, "podium-layout >>> .description")[0].textContent,
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
    .querySelector("private-layout")
    .attachShadow({ mode: "closed" }).innerHTML = "<p>Private</p>";
  assert.equal(queryElements(document, "private-layout >>> p").length, 0);
  const controller = new AbortController();
  const ready = waitForDom(
    document,
    "private-layout >>> p",
    controller.signal,
    1000,
    5,
  );
  controller.abort();
  await assert.rejects(ready, /Cancelled/);
});
