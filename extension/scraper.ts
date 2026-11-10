import { dbaListings } from "./scraper/dba";
import { LIMITS, navigationUrl, parseSpec } from "./scraper/spec";
import { browserDriver } from "./scraper/browser";
import { runScraper, type Result } from "./scraper/runner";
const editor = document.querySelector<HTMLTextAreaElement>("#spec")!;
const status = document.querySelector<HTMLElement>("#status")!;
const source = document.querySelector<HTMLElement>("#source")!;
const results = document.querySelector<HTMLElement>("#results")!;
const validate = document.querySelector<HTMLButtonElement>("#validate")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const download = document.querySelector<HTMLButtonElement>("#export")!;
const sourceTab = Number(new URL(location.href).searchParams.get("tab"));
let startUrl = "";
let origin = "";
let controller: AbortController | undefined;
let validated = "";
let result: Result | undefined;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Scraping failed.";
editor.value = JSON.stringify(
  {
    version: 1,
    name: "Marketplace listings",
    list: {
      itemSelector: ".listing-card",
      fields: {
        title: { selector: "h2", value: "text" },
        url: {
          selector: "a[href]",
          value: "attribute",
          attribute: "href",
          resolveUrl: true,
        },
      },
    },
    detail: {
      linkField: "url",
      fields: {
        description: {
          selector: ".description",
          value: "text",
          optional: true,
        },
      },
    },
    pagination: { type: "next", selector: "a[rel='next']" },
  },
  null,
  2,
);
source.textContent =
  "Loading source tab. Example selectors must be replaced for your website.";
void browser.tabs
  .get(sourceTab)
  .then((tab) => {
    if (!tab.url || tab.incognito)
      throw new Error(
        "Open a regular HTTP(S) marketplace tab and click the extension button.",
      );
    origin = new URL(tab.url).origin;
    startUrl = navigationUrl(tab.url, tab.url, origin);
    if (
      ["auth.openai.com", "api.openai.com"].includes(new URL(origin).hostname)
    )
      throw new Error("Authentication origins cannot be scraped.");
    if (
      new URL(startUrl).hostname === "www.dba.dk" &&
      new URL(startUrl).pathname === "/recommerce/forsale/search"
    ) {
      editor.value = JSON.stringify(dbaListings, null, 2);
      source.textContent = `Source: ${startUrl}. DBA example extracts the current listing page only. Detail pages and DBA pagination are not configured.`;
    } else {
      source.textContent = `Source: ${startUrl}. Example selectors must be replaced for your website.`;
    }
  })
  .catch((error: unknown) => {
    status.textContent = errorText(error);
  });
editor.addEventListener("input", () => {
  validated = "";
  run.disabled = true;
});
validate.addEventListener("click", () => {
  try {
    const spec = parseSpec(editor.value, (s) => {
      document.querySelector(s);
    });
    if (!startUrl)
      throw new Error(
        "Source tab unavailable. Open the scraper from a marketplace tab.",
      );
    validated = editor.value;
    run.disabled = false;
    status.textContent = `Valid: ${spec.name}. JSON and CSS syntax accepted; website matches are checked during execution. Approved origin: ${origin}.`;
  } catch (error) {
    validated = "";
    run.disabled = true;
    status.textContent = errorText(error);
  }
});
run.addEventListener("click", () => {
  if (!validated || validated !== editor.value || controller) return;
  const spec = parseSpec(validated, (s) => {
    document.querySelector(s);
  });
  controller = new AbortController();
  const active = controller;
  run.disabled = true;
  validate.disabled = true;
  editor.disabled = true;
  stop.disabled = false;
  download.disabled = true;
  result = undefined;
  results.textContent = "";
  status.textContent = "Requesting site access…";
  // Permission request must begin synchronously in the button's user gesture.
  const permission = browser.permissions.request({ origins: [`${origin}/*`] });
  void (async () => {
    let opened = false;
    try {
      if (!(await permission)) throw new Error("Site access was declined.");
      active.signal.throwIfAborted();
      const worker = await browser.runtime.sendMessage({
        type: "scraper.worker.open",
        sourceTab,
      });
      if (!worker?.ok || typeof worker.tab !== "number")
        throw new Error(worker?.error ?? "Worker unavailable.");
      opened = true;
      if (
        worker.origin !== origin ||
        navigationUrl(worker.startUrl, startUrl, origin) !== startUrl
      )
        throw new Error(
          "Source tab changed. Reopen the scraper from the desired page.",
        );
      result = await runScraper(
        spec,
        startUrl,
        browserDriver(worker.tab, origin),
        active.signal,
        (p) => {
          status.textContent = `${p.phase}: ${p.items} items; ${p.visits} document visits. ${p.url}`;
        },
      );
      results.textContent = JSON.stringify(result, null, 2);
      status.textContent = `${result.status}: ${result.stopReason} ${result.items.length} items; ${result.pages.length} document visits.`;
      download.disabled = false;
    } catch (error) {
      status.textContent = active.signal.aborted
        ? "Cancelled."
        : errorText(error);
    } finally {
      if (opened)
        await browser.runtime
          .sendMessage({ type: "scraper.worker.close" })
          .catch(() => {});
      controller = undefined;
      stop.disabled = true;
      validate.disabled = false;
      editor.disabled = false;
      run.disabled = validated !== editor.value;
    }
  })();
});
stop.addEventListener("click", () => {
  controller?.abort();
  stop.disabled = true;
  status.textContent = "Cancelling…";
});
window.addEventListener("pagehide", () => {
  controller?.abort();
  void browser.runtime
    .sendMessage({ type: "scraper.worker.close" })
    .catch(() => {});
});
download.addEventListener("click", () => {
  if (!result) return;
  const blob = new Blob([JSON.stringify(result, null, 2)], {
    type: "application/json",
  });
  if (blob.size > LIMITS.resultBytes + 500_000) {
    status.textContent = "Result export exceeds engine limit.";
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "scraper-results.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
