import { createStore } from "zustand/vanilla";
import type { Result } from "../scraper/runner";

export interface ModelChoice {
  id: string;
  name: string;
}
interface ScraperState {
  startUrl: string;
  origin: string;
  source: string;
  spec: string;
  validated: string;
  goal: string;
  models: ModelChoice[];
  model: string;
  busy: "scraping" | "generating" | "models" | null;
  cancelling: boolean;
  status: string;
  log: string;
  result: Result | undefined;
}

// One instance per scraper page. Website content is never persisted or shared.
export function createScraperStore(spec: string) {
  const store = createStore<ScraperState>()(() => ({
    startUrl: "",
    origin: "",
    source:
      "Loading source tab. Example selectors must be replaced for your website.",
    spec,
    validated: "",
    goal: "",
    models: [],
    model: "",
    busy: null,
    cancelling: false,
    status: "Paste a specification and validate it.",
    log: "",
    result: undefined,
  }));
  return {
    ...store,
    editSpec(spec: string) {
      store.setState({ spec, validated: "" });
    },
    begin(busy: NonNullable<ScraperState["busy"]>) {
      if (store.getState().busy) return false;
      store.setState({
        busy,
        cancelling: false,
        ...(busy === "scraping" ? { result: undefined } : {}),
        ...(busy === "generating" ? { log: "" } : {}),
      });
      return true;
    },
    finish() {
      store.setState({ busy: null, cancelling: false });
    },
  };
}
export function scraperControls(state: ScraperState) {
  const busy = state.busy !== null;
  return {
    run: busy || !state.validated || state.validated !== state.spec,
    validate: busy,
    editor: busy,
    stop: !busy || state.busy === "models" || state.cancelling,
    download: !state.result || busy,
    loadModels: busy,
    model: busy || !state.models.length,
    goal: busy,
    generate: busy || !state.startUrl || !state.model,
  };
}
