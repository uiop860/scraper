import type { MockData } from "./mock-types.ts";
import type { Spec, Field } from "../extension/scraper/spec.ts";
import { assert, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { parseSpec, navigationUrl, LIMITS } from "../extension/scraper/spec.ts";
import {
  extract,
  waitForDom,
  ReadinessError,
} from "../extension/scraper/dom.ts";
import { runScraper, resultJson } from "../extension/scraper/runner.ts";
import { guardRules } from "../extension/scraper/guard.ts";
const html = await readFile(
  new URL("./fixtures/list.html", import.meta.url),
  "utf8",
);
const start = "https://market.test/search";
const spec = {
  version: 1,
  name: "Fixture",
  list: {
    itemSelector: ".card",
    fields: {
      title: { selector: "h2", value: "text" },
      url: {
        selector: "a",
        value: "attribute",
        attribute: "href",
        resolveUrl: true,
      },
      price: { selector: ".price", value: "text", optional: true },
      images: {
        selector: "img",
        value: "attribute",
        attribute: "src",
        resolveUrl: true,
        multiple: true,
      },
      seller: {
        selector: ".seller",
        fields: { name: { selector: "b", value: "text" } },
      },
    },
  },
  detail: {
    linkField: "url",
    fields: { description: { selector: ".description", value: "text" } },
  },
  pagination: { type: "next", selector: "a[rel=next]" },
} satisfies Spec;
function document(markup = html) {
  return parseHTML(markup).document;
}
function fixtureDriver(pages: Record<string, string | Error>) {
  const calls: string[] = [];
  let closed = 0;
  return {
    calls,
    get closed() {
      return closed;
    },
    async visit(url: string, kind: "list" | "detail", spec: Spec) {
      calls.push(url);
      const markup = pages[url];
      if (markup instanceof Error) throw markup;
      if (markup === undefined) throw new Error(`Unexpected visit ${url}`);
      return extract(document(markup), spec, kind, url);
    },
    async close() {
      closed++;
    },
  };
}
const signal = () => new AbortController().signal;

test("strict schema, selector validation, recursion, and malicious properties", () => {
  assert.strictEqual(parseSpec(spec).version, 1);
  for (const input of [
    { ...spec, version: 2 },
    { ...spec, execute: "alert(1)" },
    {
      ...spec,
      list: {
        ...spec.list,
        fields: { x: { selector: "h2", value: "javascript" } },
      },
    },
    JSON.parse(
      '{"version":1,"name":"x","list":{"itemSelector":"a","fields":{"__proto__":{"selector":"a","value":"text"}}}}',
    ),
    { ...spec, detail: { ...spec.detail, linkField: "title" } },
    { ...spec, pagination: { type: "click", selector: "button" } },
    "{".repeat(10000),
    " ".repeat(LIMITS.specBytes + 1),
  ])
    assert.throws(() => parseSpec(input));
  const bad = structuredClone(spec);
  bad.list.fields.title.selector = "[";
  assert.throws(
    () => parseSpec(bad, (s: string) => document().querySelector(s)),
    /Invalid CSS/,
  );
  let nested: Field = { selector: "div", value: "text" };
  for (let i = 0; i < 7; i++) nested = { selector: "div", fields: { nested } };
  assert.throws(() =>
    parseSpec({
      version: 1,
      name: "deep",
      list: { itemSelector: "div", fields: { nested } },
    }),
  );
});

test("text, attributes, nested fields, multiple matches, missing values and hostile base URL", () => {
  const page = extract(document(), parseSpec(spec), "list", start);
  assert.strictEqual(page.items.length, 2);
  assert.strictEqual(page.items[0]!.title, "Sewing machine");
  assert.strictEqual(page.items[0]!.url, "https://market.test/detail/1");
  assert.deepStrictEqual(page.items[0]!.images, [
    "https://market.test/a.jpg",
    "https://market.test/b.jpg",
  ]);
  assert.deepStrictEqual(page.items[0]!.seller, { name: "Alice" });
  assert.strictEqual(page.items[1]!.price, null);
  assert.strictEqual(page.items[1]!.seller, null);
  assert.deepStrictEqual(page.items[1]!.images, []);
  assert.ok(
    page.diagnostics.some((d) => d.path.endsWith("seller") && d.matches === 0),
  );
  assert.ok(!page.diagnostics.some((d) => d.path.endsWith("price")));
  assert.strictEqual(page.next, "?page=2");
  const bad = structuredClone(spec);
  bad.list.fields.title.selector = "[";
  assert.ok(
    extract(document(), bad, "list", start).diagnostics.some(
      (d) => d.code === "invalid_selector",
    ),
  );
  const unsafe = extract(
    document(
      '<article class="card"><a href="javascript:alert(1)"></a></article>',
    ),
    spec,
    "list",
    start,
  );
  assert.strictEqual(unsafe.items[0]!.url, null);
  assert.ok(unsafe.diagnostics.some((d) => d.code === "invalid_url"));
});

test("pagination, detail pages, deduplication, cycles and structured source URLs", async () => {
  const driver = fixtureDriver({
    [start]: html,
    "https://market.test/detail/1": '<p class="description">Works well</p>',
    "https://market.test/detail/2": '<p class="description">Like new</p>',
    "https://market.test/search?page=2": html.replace("?page=2", "/search"),
  });
  const result = await runScraper(spec, start, driver, signal());
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(driver.calls.length, 4);
  assert.strictEqual(driver.closed, 1);
  assert.deepStrictEqual(result.items[0]!.detail, {
    description: "Works well",
  });
  assert.deepStrictEqual(result.items[0]!.source, {
    list: start,
    detail: "https://market.test/detail/1",
  });
  assert.ok(result.diagnostics.some((d) => d.code === "pagination_cycle"));
  const exported = JSON.parse(resultJson(result));
  assert.strictEqual(Object.hasOwn(exported, "pages"), false);
  assert.strictEqual(Object.hasOwn(exported, "diagnostics"), false);
  assert.deepStrictEqual(
    exported.items,
    result.items.map((item) => ({ data: item.data, detail: item.detail })),
  );
  assert.ok(
    exported.items.every((item: MockData) => !Object.hasOwn(item, "source")),
  );
});

test("detail failures retain listing data, duplicate detail links are visited once", async () => {
  const driver = fixtureDriver({
    [start]: html
      .replace("/detail/2", "/detail/1")
      .replace('<a rel="next" href="?page=2">Next</a>', ""),
    "https://market.test/detail/1": new Error("Timeout"),
  });
  const result = await runScraper(
    { ...spec, identityField: "title" },
    start,
    driver,
    signal(),
  );
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(driver.calls.length, 2);
  assert.strictEqual(result.items[0]!.detail, null);
  assert.ok(result.diagnostics.some((d) => d.code === "detail_failed"));
});

test("navigation restrictions reject off-origin targets, credentials and schemes", async () => {
  for (const url of [
    "https://market.test.evil.test/x",
    "http://market.test/x",
    "https://market.test:444/x",
    "https://user@market.test/x",
    "javascript:alert(1)",
    "file:///tmp/x",
  ])
    assert.throws(() => navigationUrl(url, start, new URL(start).origin));
  assert.strictEqual(
    navigationUrl("/a#b", start, new URL(start).origin),
    "https://market.test/a",
  );
  const driver = fixtureDriver({
    [start]: html
      .replace("?page=2", "https://evil.test/")
      .replaceAll("/detail/", "https://evil.test/detail/"),
  });
  const result = await runScraper(spec, start, driver, signal());
  assert.strictEqual(result.status, "failed");
  assert.deepStrictEqual(driver.calls, [start]);
  assert.strictEqual(result.items.length, 2);
});

test("engine independently enforces page, item and result limits", async () => {
  let count = 0;
  const driver = {
    async visit(url: string) {
      count++;
      return {
        url,
        items: [{ title: String(count) }],
        next: `?p=${count}`,
        diagnostics: [],
      };
    },
    async close() {},
  };
  const simple = {
    version: 1,
    name: "limits",
    list: {
      itemSelector: "a",
      fields: { title: { selector: "a", value: "text" } },
    },
    pagination: { type: "next", selector: "a" },
  };
  const pageLimit = await runScraper(simple, start, driver, signal());
  assert.strictEqual(pageLimit.status, "limited");
  assert.strictEqual(count, LIMITS.pages);
  const many = {
    async visit(url: string) {
      return {
        url,
        items: Array.from({ length: 201 }, (_, i) => ({ title: String(i) })),
        next: null,
        diagnostics: [],
      };
    },
    async close() {},
  };
  const itemLimit = await runScraper(simple, start, many, signal());
  assert.strictEqual(itemLimit.items.length, LIMITS.items);
  assert.strictEqual(itemLimit.status, "limited");
  const huge = {
    async visit(url: string) {
      return {
        url,
        items: [{ title: "x".repeat(LIMITS.resultBytes) }],
        next: null,
        diagnostics: [],
      };
    },
    async close() {},
  };
  const sizeLimit = await runScraper(simple, start, huge, signal());
  assert.strictEqual(sizeLimit.status, "limited");
  assert.strictEqual(sizeLimit.items.length, 0);
});

test("cancellation interrupts an unresponsive driver and preserves partial data", async () => {
  const controller = new AbortController();
  let closed = false;
  const driver = {
    async visit(url: string, kind: "list" | "detail") {
      if (kind === "list")
        return {
          url,
          items: [{ url: "/detail/1", title: "saved" }],
          next: null,
          diagnostics: [],
        };
      controller.abort();
      return new Promise<never>(() => {});
    },
    async close() {
      closed = true;
    },
  };
  const result = await runScraper(spec, start, driver, controller.signal);
  assert.strictEqual(result.status, "cancelled");
  assert.strictEqual(result.items[0]!.data.title, "saved");
  assert.strictEqual(closed, true);
});

test("dynamic content waits for insertion and settles; timeouts and cancellation release observers", async () => {
  const doc = document("<main></main>");
  const waiting = waitForDom(doc, ".ready", signal(), 200, 10);
  setTimeout(() => {
    doc.querySelector("main")!.innerHTML = '<p class="ready">Loaded</p>';
  }, 10);
  await waiting;
  await expect(waitForDom(doc, ".never", signal(), 20, 1)).rejects.toThrow(
    /timed out/,
  );
  const controller = new AbortController();
  const cancelled = waitForDom(doc, ".never", controller.signal, 100, 1);
  controller.abort();
  await expect(cancelled).rejects.toThrow(/Cancelled/);
  await expect(waitForDom(doc, "[", signal(), 20, 1)).rejects.toThrow(
    /Invalid/,
  );
});

test("navigation guard is tab-scoped and permits only exact origin boundaries", () => {
  const [block, allow] = guardRules(42, "https://market.test");
  assert.deepStrictEqual(block!.condition.tabIds, [42]);
  assert.strictEqual(block!.action.type, "block");
  assert.ok(allow!.priority! > block!.priority!);
  const regex = new RegExp(allow!.condition.regexFilter!);
  assert.ok(regex.test(start));
  for (const url of [
    "https://market.test.evil/x",
    "http://market.test/x",
    "https://market.test:444/x",
    "https://marketXtest/x",
  ])
    assert.ok(!regex.test(url));
});

test("execution deadline cancels a stalled visit without relying on the spec", async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const entered = Promise.withResolvers<void>();
  let closed = false;
  const driver = {
    async visit() {
      entered.resolve();
      return new Promise<never>(() => {});
    },
    async close() {
      closed = true;
    },
  };
  const running = runScraper(spec, start, driver, signal());
  await entered.promise;
  vi.advanceTimersByTime(LIMITS.durationMs);
  const result = await running;
  assert.strictEqual(result.status, "limited");
  assert.match(result.stopReason, /time limit/);
  assert.strictEqual(closed, true);
});

test("unrelated continuously updating content does not starve readiness", async () => {
  const doc = document('<main class="ready">Ready</main><aside>Ads</aside>');
  const interval = setInterval(() => {
    doc.querySelector("aside")!.textContent = String(Math.random());
  }, 2);
  try {
    await waitForDom(doc, ".ready", signal(), 100, 15);
  } finally {
    clearInterval(interval);
  }
});

test("readiness timeout distinguishes missing matches from unstable matched content", async () => {
  const doc = document('<main class="ready">Ready</main>');
  await expect(
    waitForDom(doc, ".listing-card", signal(), 20, 5),
  ).rejects.toSatisfy((error: unknown) => {
    assert.ok(error instanceof ReadinessError);
    assert.strictEqual(error.selector, ".listing-card");
    assert.strictEqual(error.matches, 0);
    assert.match(error.message, /matched 0 elements/);
    return true;
  });
  const interval = setInterval(() => {
    doc.querySelector("main")!.textContent = String(Math.random());
  }, 2);
  try {
    await expect(waitForDom(doc, ".ready", signal(), 30, 15)).rejects.toSatisfy(
      (error: unknown) => {
        assert.ok(error instanceof ReadinessError);
        assert.strictEqual(error.matches, 1);
        assert.match(error.message, /kept changing/);
        return true;
      },
    );
  } finally {
    clearInterval(interval);
  }
});

test("DBA example extracts actual listing structure without illustrative classes", async () => {
  const { dbaListings } = await import("../extension/scraper/dba.ts");
  const doc = document(
    '<article class="sf-search-ad"><a class="sf-search-ad-link" href="/recommerce/forsale/item/123"></a><h2>Machine</h2><div class="font-bold"><span>500 kr.</span></div><img src="https://images.dbastatic.dk/a.jpg"></article>',
  );
  const page = extract(
    doc,
    parseSpec(dbaListings),
    "list",
    "https://www.dba.dk/recommerce/forsale/search",
  );
  assert.strictEqual(page.items.length, 1);
  assert.strictEqual(page.items[0]!.price, "500 kr.");
  assert.strictEqual(
    page.items[0]!.url,
    "https://www.dba.dk/recommerce/forsale/item/123",
  );
  assert.strictEqual(page.diagnostics.length, 0);
});

test("listing-only results omit detail from exported items", async () => {
  const listingOnly = { version: 1, name: "Listing only", list: spec.list };
  const driver = fixtureDriver({ [start]: html });
  const result = await runScraper(listingOnly, start, driver, signal());
  assert.ok(result.items.length > 0);
  assert.ok(result.items.every((item) => !Object.hasOwn(item, "detail")));
  const exported = JSON.parse(resultJson(result));
  assert.deepStrictEqual(
    exported.items,
    result.items.map(({ data }) => ({ data })),
  );
});
