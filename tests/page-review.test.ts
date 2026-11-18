import { assert, test, vi } from "vitest";
import { parseHTML } from "linkedom";
import {
  highlightExample,
  reviewTargets,
} from "../extension/scraper/page-review.ts";

function page() {
  const { window, document } = parseHTML(
    '<html><body><article><h2>Oak desk</h2><span class="price">500 kr</span></article></body></html>',
  );
  const roots: ShadowRoot[] = [];
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function (
    options: ShadowRootInit,
  ) {
    const root = attach.call(this, options);
    roots.push(root);
    return root;
  };
  const rect = {
    left: 20,
    top: 30,
    right: 140,
    bottom: 60,
    width: 120,
    height: 30,
    x: 20,
    y: 30,
    toJSON() {},
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => rect;
  window.HTMLElement.prototype.getClientRects = () =>
    [rect] as unknown as DOMRectList;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  return {
    document,
    window,
    roots,
    close() {
      (
        window as unknown as { __scraperReviewCleanup?: () => void }
      ).__scraperReviewCleanup?.();
      vi.unstubAllGlobals();
    },
  };
}
const targets = () =>
  reviewTargets({
    title: { selector: "h2", value: "text" },
    price: { selector: ".price", value: "text" },
  });

test("page review highlights each field in one listing and requires all checkmarks", async () => {
  const h = page();
  try {
    const result = highlightExample(["article"], targets());
    const root = h.roots[0]!;
    assert.match(root.querySelector("p")!.textContent!, /1 of 2.*title/);
    assert.ok(root.querySelector(".outline"));
    (root.querySelector(".yes") as HTMLButtonElement).click();
    assert.match(root.querySelector("p")!.textContent!, /2 of 2.*price/);
    (root.querySelector(".yes") as HTMLButtonElement).click();
    assert.deepStrictEqual(await result, { status: "confirmed" });
    assert.strictEqual(h.document.querySelectorAll("body article").length, 1);
    assert.strictEqual(h.document.documentElement.children.length, 1);
  } finally {
    h.close();
  }
});

test("rejecting a field reports its name and removes the highlight", async () => {
  const h = page();
  try {
    const result = highlightExample(["article"], targets());
    (h.roots[0]!.querySelector(".no") as HTMLButtonElement).click();
    assert.deepStrictEqual(await result, {
      status: "rejected",
      field: "title",
    });
    assert.strictEqual(h.document.documentElement.children.length, 1);
  } finally {
    h.close();
  }
});

test("missing fields cannot be confirmed and replacing a review dismisses the old one", async () => {
  const h = page();
  try {
    const first = highlightExample(["article"], targets());
    const missing = highlightExample(
      ["article"],
      [{ label: "description", path: [[".missing"]] }],
    );
    assert.deepStrictEqual(await first, { status: "dismissed" });
    assert.deepStrictEqual(await missing, {
      status: "unavailable",
      field: "description",
    });
    const next = highlightExample(["article"], targets());
    const event = new h.window.Event("keydown");
    Object.assign(event, { key: "Escape" });
    h.window.dispatchEvent(event);
    assert.deepStrictEqual(await next, { status: "dismissed" });
  } finally {
    h.close();
  }
});

test("review targets preserve nested and shadow selector boundaries", () => {
  assert.deepStrictEqual(
    reviewTargets({
      seller: {
        selector: "seller-card >>> .info",
        fields: { name: { selector: ":scope", value: "text" } },
      },
    }),
    [{ label: "seller / name", path: [["seller-card", ".info"], [":scope"]] }],
  );
});
