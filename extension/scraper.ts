import { validateSelector } from "./scraper/selectors";
import { generateScraper } from "./scraper/agent";
import { dbaListings } from "./scraper/dba";
import { LIMITS, navigationUrl, parseSpec } from "./scraper/spec";
import { browserDriver } from "./scraper/browser";
import { runScraper, resultJson, type Result } from "./scraper/runner";
const editor = document.querySelector<HTMLTextAreaElement>("#spec")!;
const status = document.querySelector<HTMLElement>("#status")!;
const source = document.querySelector<HTMLElement>("#source")!;
const results = document.querySelector<HTMLElement>("#results")!;
const validate = document.querySelector<HTMLButtonElement>("#validate")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const download = document.querySelector<HTMLButtonElement>("#export")!;
const sourceTab = Number(new URL(location.href).searchParams.get("tab"));
const loadModels = document.querySelector<HTMLButtonElement>("#load-models")!;
const model = document.querySelector<HTMLSelectElement>("#agent-model")!;
const goal = document.querySelector<HTMLTextAreaElement>("#agent-goal")!;
const generate = document.querySelector<HTMLButtonElement>("#generate")!;
const agentLog = document.querySelector<HTMLElement>("#agent-log")!;
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
      source.textContent = `Source: ${startUrl}. DBA preset follows each listing link and extracts its description. Next-page pagination is not preconfigured; use the agent to configure it when available.`;
    } else {
      source.textContent = `Source: ${startUrl}. Example selectors must be replaced for your website.`;
    }
    generate.disabled = !!controller || !model.value;
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
    const spec = parseSpec(editor.value, validateSelector);
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
  const spec = parseSpec(validated, validateSelector);
  controller = new AbortController();
  const active = controller;
  run.disabled = true;
  validate.disabled = true;
  editor.disabled = true;
  stop.disabled = false;
  download.disabled = true;
  generate.disabled = true;
  loadModels.disabled = true;
  model.disabled = true;
  goal.disabled = true;
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
      results.textContent = resultJson(result);
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
      run.disabled = !validated || validated !== editor.value;
      loadModels.disabled = false;
      model.disabled = !model.options.length;
      goal.disabled = false;
      generate.disabled = !model.value || !startUrl;
    }
  })();
});
stop.addEventListener("click", () => {
  controller?.abort();
  void browser.runtime
    .sendMessage({ type: "scraper.agent.cancel" })
    .catch(() => {});
  stop.disabled = true;
  status.textContent = "Cancelling…";
});
window.addEventListener("pagehide", () => {
  controller?.abort();
  void browser.runtime
    .sendMessage({ type: "scraper.agent.cancel" })
    .catch(() => {});
  void browser.runtime
    .sendMessage({ type: "scraper.worker.close" })
    .catch(() => {});
});
download.addEventListener("click", () => {
  if (!result) return;
  const blob = new Blob([resultJson(result)], {
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

loadModels.addEventListener("click", () => {
  if (controller) return;
  loadModels.disabled = true;
  generate.disabled = true;
  status.textContent = "Loading available models…";
  void (async () => {
    try {
      const response = await browser.runtime.sendMessage({
        type: "scraper.agent.models",
      });
      if (!response?.ok)
        throw new Error(response?.error ?? "Models unavailable.");
      model.replaceChildren();
      for (const choice of response.models) {
        const option = document.createElement("option");
        option.value = choice.id;
        option.textContent = choice.name;
        model.append(option);
      }
      status.textContent = model.options.length
        ? "Describe the data you want, then generate a scraper."
        : "No available models. Check Account settings.";
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      loadModels.disabled = false;
      model.disabled = !model.options.length;
      generate.disabled = !model.value || !startUrl;
    }
  })();
});
generate.addEventListener("click", () => {
  if (controller || !startUrl || !model.value) return;
  const request = goal.value.trim();
  if (!request) {
    status.textContent = "Describe the data you want to scrape.";
    return;
  }
  // Firefox requires optional permission requests inside the user gesture.
  const permission = browser.permissions.request({
    origins: [`${origin}/*`],
    data_collection: ["websiteContent", "browsingActivity"],
  });
  const active = new AbortController();
  controller = active;
  for (const control of [
    generate,
    loadModels,
    model,
    goal,
    validate,
    run,
    editor,
  ])
    control.disabled = true;
  stop.disabled = false;
  agentLog.textContent = "";
  status.textContent = "Requesting site access…";
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
      const spec = await generateScraper(
        request,
        startUrl,
        browserDriver(worker.tab, origin),
        async (input, signal) => {
          signal.throwIfAborted();
          const response = await browser.runtime.sendMessage({
            type: "scraper.agent.turn",
            model: model.value,
            input,
          });
          signal.throwIfAborted();
          if (!response?.ok)
            throw new Error(response?.error ?? "Agent unavailable.");
          return response;
        },
        active.signal,
        (message) => {
          status.textContent = message;
          agentLog.textContent += message + "\n";
        },
      );
      active.signal.throwIfAborted();
      editor.value = JSON.stringify(spec, null, 2);
      validated = editor.value;
      status.textContent = `Generated and sample-tested: ${spec.name}. Review the JSON, then run the full scraper. See the agent log for test coverage.`;
    } catch (error) {
      status.textContent = active.signal.aborted
        ? "Generation cancelled."
        : errorText(error);
    } finally {
      await browser.runtime
        .sendMessage({ type: "scraper.agent.cancel" })
        .catch(() => {});
      if (opened)
        await browser.runtime
          .sendMessage({ type: "scraper.worker.close" })
          .catch(() => {});
      controller = undefined;
      for (const control of [loadModels, goal, validate, editor])
        control.disabled = false;
      model.disabled = !model.options.length;
      generate.disabled = !model.value || !startUrl;
      run.disabled = !validated || validated !== editor.value;
      stop.disabled = true;
    }
  })();
});
