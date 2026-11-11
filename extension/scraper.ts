import { createScraperStore, scraperControls } from "./state/scraper";
import { validateSelector } from "./scraper/selectors";
import { generateScraper } from "./scraper/agent";
import { dbaListings } from "./scraper/dba";
import { LIMITS, navigationUrl, parseSpec } from "./scraper/spec";
import { browserDriver } from "./scraper/browser";
import { runScraper, resultJson } from "./scraper/runner";
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
const initialSpec = JSON.stringify(
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
const store = createScraperStore(initialSpec);
let controller: AbortController | undefined;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Scraping failed.";
function render() {
  const state = store.getState();
  const disabled = scraperControls(state);
  if (editor.value !== state.spec) editor.value = state.spec;
  if (goal.value !== state.goal) goal.value = state.goal;
  source.textContent = state.source;
  status.textContent = state.status;
  agentLog.textContent = state.log;
  run.disabled = disabled.run;
  validate.disabled = disabled.validate;
  editor.disabled = disabled.editor;
  stop.disabled = disabled.stop;
  download.disabled = disabled.download;
  loadModels.disabled = disabled.loadModels;
  model.disabled = disabled.model;
  goal.disabled = disabled.goal;
  generate.disabled = disabled.generate;
}
const unsubscribe = store.subscribe((state, previous) => {
  if (state.models !== previous.models) {
    model.replaceChildren(
      ...state.models.map((choice) => new Option(choice.name, choice.id)),
    );
  }
  model.value = state.model;
  if (state.result !== previous.result)
    results.textContent = state.result ? resultJson(state.result) : "";
  render();
});
render();
void browser.tabs
  .get(sourceTab)
  .then((tab) => {
    if (!tab.url || tab.incognito)
      throw new Error(
        "Open a regular HTTP(S) marketplace tab and click the extension button.",
      );
    const origin = new URL(tab.url).origin;
    const startUrl = navigationUrl(tab.url, tab.url, origin);
    if (
      ["auth.openai.com", "api.openai.com"].includes(new URL(origin).hostname)
    )
      throw new Error("Authentication origins cannot be scraped.");
    const preset =
      new URL(startUrl).hostname === "www.dba.dk" &&
      new URL(startUrl).pathname === "/recommerce/forsale/search";
    // Do not overwrite edits made while the source tab was loading.
    if (preset && store.getState().spec === initialSpec)
      store.editSpec(JSON.stringify(dbaListings, null, 2));
    store.setState({
      startUrl,
      origin,
      source: preset
        ? `Source: ${startUrl}. DBA preset follows each listing link and extracts its description. Next-page pagination is not preconfigured; use the agent to configure it when available.`
        : `Source: ${startUrl}. Example selectors must be replaced for your website.`,
    });
  })
  .catch((error: unknown) => store.setState({ status: errorText(error) }));
editor.addEventListener("input", () => store.editSpec(editor.value));
goal.addEventListener("input", () => store.setState({ goal: goal.value }));
model.addEventListener("change", () => store.setState({ model: model.value }));
validate.addEventListener("click", () => {
  try {
    const state = store.getState();
    const spec = parseSpec(state.spec, validateSelector);
    if (!state.startUrl)
      throw new Error(
        "Source tab unavailable. Open the scraper from a marketplace tab.",
      );
    store.setState({
      validated: state.spec,
      status: `Valid: ${spec.name}. JSON and CSS syntax accepted; website matches are checked during execution. Approved origin: ${state.origin}.`,
    });
  } catch (error) {
    store.setState({ validated: "", status: errorText(error) });
  }
});
function execute(generating: boolean) {
  const state = store.getState();
  if (state.busy || !state.startUrl) return;
  if (generating && (!state.model || !state.goal.trim())) {
    store.setState({ status: "Describe the data you want to scrape." });
    return;
  }
  if (!generating && scraperControls(state).run) return;
  // Start permissions synchronously inside the user gesture, before any await.
  const permission = browser.permissions.request({
    origins: [`${state.origin}/*`],
    ...(generating
      ? { data_collection: ["websiteContent", "browsingActivity"] as const }
      : {}),
  });
  const active = new AbortController();
  controller = active;
  store.begin(generating ? "generating" : "scraping");
  store.setState({ status: "Requesting site access…" });
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
        worker.origin !== state.origin ||
        navigationUrl(worker.startUrl, state.startUrl, state.origin) !==
          state.startUrl
      )
        throw new Error(
          "Source tab changed. Reopen the scraper from the desired page.",
        );
      const driver = browserDriver(worker.tab, state.origin);
      if (generating) {
        const spec = await generateScraper(
          state.goal.trim(),
          state.startUrl,
          driver,
          async (input, signal) => {
            signal.throwIfAborted();
            const response = await browser.runtime.sendMessage({
              type: "scraper.agent.turn",
              model: state.model,
              input,
            });
            signal.throwIfAborted();
            if (!response?.ok)
              throw new Error(response?.error ?? "Agent unavailable.");
            return response;
          },
          active.signal,
          (message) =>
            store.setState((s) => ({
              status: message,
              log: s.log + message + "\n",
            })),
        );
        active.signal.throwIfAborted();
        const json = JSON.stringify(spec, null, 2);
        store.setState({
          spec: json,
          validated: json,
          status: `Generated and sample-tested: ${spec.name}. Review the JSON, then run the full scraper. See the agent log for test coverage.`,
        });
      } else {
        const result = await runScraper(
          parseSpec(state.validated, validateSelector),
          state.startUrl,
          driver,
          active.signal,
          (p) =>
            store.setState({
              status: `${p.phase}: ${p.items} items; ${p.visits} document visits. ${p.url}`,
            }),
        );
        store.setState({
          result,
          status: `${result.status}: ${result.stopReason} ${result.items.length} items; ${result.pages.length} document visits.`,
        });
      }
    } catch (error) {
      store.setState({
        status: active.signal.aborted
          ? generating
            ? "Generation cancelled."
            : "Cancelled."
          : errorText(error),
      });
    } finally {
      if (generating)
        await browser.runtime
          .sendMessage({ type: "scraper.agent.cancel" })
          .catch(() => {});
      if (opened)
        await browser.runtime
          .sendMessage({ type: "scraper.worker.close" })
          .catch(() => {});
      controller = undefined;
      store.finish();
    }
  })();
}
run.addEventListener("click", () => execute(false));
generate.addEventListener("click", () => execute(true));
stop.addEventListener("click", () => {
  controller?.abort();
  void browser.runtime
    .sendMessage({ type: "scraper.agent.cancel" })
    .catch(() => {});
  store.setState({ cancelling: true, status: "Cancelling…" });
});
window.addEventListener("pagehide", () => {
  unsubscribe();
  controller?.abort();
  void browser.runtime
    .sendMessage({ type: "scraper.agent.cancel" })
    .catch(() => {});
  void browser.runtime
    .sendMessage({ type: "scraper.worker.close" })
    .catch(() => {});
});
download.addEventListener("click", () => {
  const { result } = store.getState();
  if (!result) return;
  const blob = new Blob([resultJson(result)], { type: "application/json" });
  if (blob.size > LIMITS.resultBytes + 500_000) {
    store.setState({ status: "Result export exceeds engine limit." });
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
  if (!store.begin("models")) return;
  store.setState({ status: "Loading available models…" });
  void (async () => {
    try {
      const response = await browser.runtime.sendMessage({
        type: "scraper.agent.models",
      });
      if (!response?.ok)
        throw new Error(response?.error ?? "Models unavailable.");
      store.setState({
        models: response.models,
        model: response.models[0]?.id ?? "",
        status: response.models.length
          ? "Describe the data you want, then generate a scraper."
          : "No available models. Check Account settings.",
      });
    } catch (error) {
      store.setState({ status: errorText(error) });
    } finally {
      store.finish();
    }
  })();
});
