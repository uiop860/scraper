import { createStore } from "zustand/vanilla";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { Result } from "../scraper/runner";

export interface ModelChoice {
  id: string;
  name: string;
}
interface ScraperState {
  messages: ThreadMessageLike[];
  sourceTab?: number;
  startUrl: string;
  origin: string;
  source: string;
  spec: string;
  validated: string;
  models: ModelChoice[];
  model: string;
  busy: "scraping" | "generating" | "models" | null;
  cancelling: boolean;
  status: string;
  result: Result | undefined;
}

// One instance per scraper page. Website content is never persisted or shared.
export function createScraperStore(spec: string) {
  const store = createStore<ScraperState>()(() => ({
    messages: [],
    startUrl: "",
    origin: "",
    source:
      "Loading source tab. Example selectors must be replaced for your website.",
    spec,
    validated: "",
    models: [],
    model: "",
    busy: null,
    cancelling: false,
    status: "Paste a specification and validate it.",
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
    generate: busy || !state.startUrl || !state.model,
  };
}
