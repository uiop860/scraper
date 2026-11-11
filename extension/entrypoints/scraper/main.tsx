import "./style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { mountPage } from "../../ui/root";
import { useStore } from "zustand";
import { createScraperStore, scraperControls } from "../../state/scraper";
import { storeField } from "../../state/field";
import { Chat } from "../../scraper/chat";
import { validateSelector } from "../../scraper/selectors";
import { generateScraper } from "../../scraper/agent";
import { dbaListings } from "../../scraper/dba";
import { LIMITS, navigationUrl, parseSpec } from "../../scraper/spec";
import { browserDriver } from "../../scraper/browser";
import { runScraper, resultJson } from "../../scraper/runner";

const example = JSON.stringify(
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
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Scraping failed.";
type Source = { tab?: number; url: string; origin: string; label: string };
const emptySource: Source = {
  url: "",
  origin: "",
  label: "Loading active tab…",
};

function Scraper() {
  const [store] = useState(() => {
    const store = createScraperStore(example);
    store.setState({
      source: emptySource.label,
      status: "Load a model to chat, or open the JSON editor below.",
    });
    return store;
  });
  const snapshot = useStore(store);
  const {
    spec: editor,
    status,
    models,
    model,
    result,
    messages,
    busy: operation,
  } = snapshot;
  const source: Source = {
    tab: snapshot.sourceTab,
    url: snapshot.startUrl,
    origin: snapshot.origin,
    label: snapshot.source,
  };
  const busy = operation === "scraping" || operation === "generating";
  const controls = scraperControls(snapshot);
  const setEditor = storeField(store, "spec");
  const setValidated = storeField(store, "validated");
  const setStatus = storeField(store, "status");
  const setModels = storeField(store, "models");
  const setModel = storeField(store, "model");
  const setResult = storeField(store, "result");
  const setMessages = storeField(store, "messages");
  const setCancelling = storeField(store, "cancelling");
  const [workerTab, setWorkerTab] = useState<number>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [exportUrl, setExportUrl] = useState("");
  const active = useRef<AbortController | undefined>(undefined);
  const windowId = useRef<number | undefined>(undefined);
  const live = useRef(false);
  const edited = useRef(false);
  const refreshSequence = useRef(0);

  const refreshSource = useCallback(async () => {
    if (!live.current || active.current || windowId.current === undefined)
      return;
    const sequence = ++refreshSequence.current;
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        windowId: windowId.current,
      });
      if (
        !live.current ||
        active.current ||
        sequence !== refreshSequence.current
      )
        return;
      if (!tab?.url || tab.incognito)
        throw new Error("Select a regular HTTP(S) page to scrape.");
      const origin = new URL(tab.url).origin;
      const url = navigationUrl(tab.url, tab.url, origin);
      if (
        ["auth.openai.com", "api.openai.com"].includes(new URL(origin).hostname)
      )
        throw new Error("Authentication origins cannot be scraped.");
      store.setState({ sourceTab: tab.id, startUrl: url, origin, source: url });
      if (
        !edited.current &&
        new URL(url).hostname === "www.dba.dk" &&
        new URL(url).pathname === "/recommerce/forsale/search"
      ) {
        edited.current = true;
        store.editSpec(JSON.stringify(dbaListings, null, 2));
      }
    } catch (error) {
      if (
        live.current &&
        !active.current &&
        sequence === refreshSequence.current
      )
        store.setState({
          sourceTab: undefined,
          startUrl: "",
          origin: "",
          source: errorText(error),
        });
    }
  }, [store]);

  useEffect(() => {
    live.current = true;
    let connection: browser.runtime.Port | undefined;
    const refresh = () => {
      void refreshSource();
    };
    const updated = (
      _id: number,
      change: browser.tabs._OnUpdatedChangeInfo,
    ) => {
      if (change.url || change.status === "complete") refresh();
    };
    function cleanup() {
      if (!live.current) return;
      live.current = false;
      active.current?.abort();
      connection?.disconnect();
      void browser.runtime
        .sendMessage({ type: "scraper.agent.cancel" })
        .catch(() => {});
      void browser.runtime
        .sendMessage({ type: "scraper.worker.close" })
        .catch(() => {});
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(updated);
      browser.tabs.onRemoved.removeListener(refresh);
      window.removeEventListener("pagehide", cleanup);
    }
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(updated);
    browser.tabs.onRemoved.addListener(refresh);
    window.addEventListener("pagehide", cleanup);
    void browser.windows
      .getCurrent()
      .then(async (window) => {
        if (!live.current || window.incognito || window.id === undefined)
          return;
        windowId.current = window.id;
        if (
          new URL(location.href).searchParams.get("window") !==
          String(window.id)
        ) {
          location.replace(
            browser.runtime.getURL(`scraper.html?window=${window.id}`),
          );
          return;
        }
        connection = browser.runtime.connect({ name: "scraper.sidebar" });
        await refreshSource();
      })
      .catch((error: unknown) => {
        if (live.current) store.setState({ status: errorText(error) });
      });
    return cleanup;
  }, [refreshSource, store]);

  useEffect(() => {
    if (!result) {
      setExportUrl("");
      return;
    }
    const blob = new Blob([resultJson(result)], { type: "application/json" });
    if (blob.size > LIMITS.resultBytes + 500_000) {
      setStatus("Result export exceeds engine limit.");
      return;
    }
    const url = URL.createObjectURL(blob);
    setExportUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  function validate() {
    try {
      const spec = parseSpec(editor, validateSelector);
      if (!source.url)
        throw new Error(
          "Source tab unavailable. Select a regular HTTP(S) page.",
        );
      setValidated(editor);
      setStatus(
        `Valid: ${spec.name}. JSON and CSS syntax accepted; website matches are checked during execution. Approved origin: ${source.origin}.`,
      );
    } catch (error) {
      setValidated("");
      setStatus(errorText(error));
    }
  }
  async function loadModels() {
    if (active.current) return;
    if (!store.begin("models")) return;
    setStatus("Loading available models…");
    try {
      const response = await browser.runtime.sendMessage({
        type: "scraper.agent.models",
      });
      if (!response?.ok)
        throw new Error(response?.error ?? "Models unavailable.");
      setModels(response.models);
      setModel(response.models[0]?.id ?? "");
      setStatus(
        response.models.length
          ? "Describe the data you want, then generate a scraper."
          : "No available models. Check Account settings.",
      );
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      store.finish();
    }
  }
  function cancel() {
    active.current?.abort();
    setCancelling(true);
    setStatus("Cancelling…");
    void browser.runtime
      .sendMessage({ type: "scraper.agent.cancel" })
      .catch(() => {});
  }
  function reviseReply(id: string, text: string) {
    setMessages((previous) =>
      previous.map((message) =>
        message.id === id ? { ...message, content: text } : message,
      ),
    );
  }

  async function execute(permission: Promise<boolean>, request?: string) {
    if (active.current || store.getState().busy || !source.url) return;
    if (
      request !== undefined &&
      (!model || !request.trim() || request.length > 4000)
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    store.begin(request !== undefined ? "generating" : "scraping");
    setCancelling(false);
    setStatus("Requesting site access…");
    let reply = "";
    let log = "";
    let opened = false;
    if (request !== undefined) {
      reply = crypto.randomUUID();
      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role: "user", content: request },
        { id: reply, role: "assistant", content: "Requesting site access…" },
      ]);
    } else {
      setResult(undefined);
    }
    try {
      if (!(await permission)) throw new Error("Site access was declined.");
      controller.signal.throwIfAborted();
      const worker = await browser.runtime.sendMessage({
        type: "scraper.worker.open",
        sourceTab: source.tab,
      });
      if (!worker?.ok || typeof worker.tab !== "number")
        throw new Error(worker?.error ?? "Worker unavailable.");
      opened = true;
      controller.signal.throwIfAborted();
      setWorkerTab(worker.tab);
      if (
        worker.origin !== source.origin ||
        navigationUrl(worker.startUrl, source.url, source.origin) !== source.url
      )
        throw new Error("Source tab changed. Try again from the desired page.");
      const driver = browserDriver(worker.tab, source.origin);
      if (request !== undefined) {
        const spec = await generateScraper(
          `${request}\nCurrent JSON to revise (may contain example selectors):\n${editor}`,
          source.url,
          driver,
          async (input, signal) => {
            signal.throwIfAborted();
            const response = await browser.runtime.sendMessage({
              type: "scraper.agent.turn",
              model,
              input,
            });
            signal.throwIfAborted();
            if (!response?.ok)
              throw new Error(response?.error ?? "Agent unavailable.");
            return response;
          },
          controller.signal,
          (message) => {
            setStatus(message);
            log += message + "\n";
            reviseReply(reply, log);
          },
        );
        controller.signal.throwIfAborted();
        const json = JSON.stringify(spec, null, 2);
        edited.current = true;
        setEditor(json);
        setValidated(json);
        setEditorOpen(true);
        const message = `Generated and sample-tested: ${spec.name}. Review the JSON, then run the full scraper. See the conversation for test coverage.`;
        setStatus(message);
        reviseReply(reply, `${log}\n${message}`);
      } else {
        const data = await runScraper(
          parseSpec(editor, validateSelector),
          source.url,
          driver,
          controller.signal,
          (progress) =>
            setStatus(
              `${progress.phase}: ${progress.items} items; ${progress.visits} document visits. ${progress.url}`,
            ),
        );
        setResult(data);
        setResultsOpen(true);
        setStatus(
          `${data.status}: ${data.stopReason} ${data.items.length} items; ${data.pages.length} document visits.`,
        );
      }
    } catch (error) {
      const message = controller.signal.aborted
        ? request !== undefined
          ? "Generation cancelled."
          : "Cancelled."
        : errorText(error);
      setStatus(message);
      if (reply) reviseReply(reply, `${log}\n${message}`);
    } finally {
      if (request !== undefined)
        await browser.runtime
          .sendMessage({ type: "scraper.agent.cancel" })
          .catch(() => {});
      if (opened)
        await browser.runtime
          .sendMessage({ type: "scraper.worker.close" })
          .catch(() => {});
      active.current = undefined;
      store.finish();
      setCancelling(false);
      setWorkerTab(undefined);
      void refreshSource();
    }
  }

  return (
    <main>
      <header>
        <div>
          <h1>Scraper</h1>
          <span className="subtitle">Your data, structured.</span>
        </div>
        <button
          id="settings"
          aria-label="Open account settings"
          onClick={() => {
            void browser.runtime.openOptionsPage();
          }}
        >
          Settings ↗
        </button>
      </header>
      <section className="source-card" aria-label="Current page">
        <span className="eyebrow">{busy ? "RUNNING ON" : "CURRENT PAGE"}</span>
        <p id="source">{source.label}</p>
        {workerTab !== undefined && (
          <button
            id="follow"
            onClick={() => {
              void browser.tabs.update(workerTab, { active: true });
            }}
          >
            View agent’s tab ↗
          </button>
        )}
      </section>
      <div className="model-row">
        <button
          id="load-models"
          disabled={controls.loadModels}
          onClick={() => {
            void loadModels();
          }}
        >
          Load models
        </button>
        <label htmlFor="agent-model">Model</label>
        <select
          id="agent-model"
          value={model}
          disabled={controls.model}
          onChange={(event) => setModel(event.target.value)}
        >
          {models.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.name}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">
        Sign in and unlock in Settings to chat. JSON scraping works without
        sign-in.
      </p>
      <section id="chat" aria-label="Scraper conversation">
        <Chat
          messages={messages}
          running={busy}
          disabled={controls.generate}
          requestPermission={() =>
            browser.permissions.request({
              origins: [`${source.origin}/*`],
              data_collection: ["websiteContent", "browsingActivity"],
            })
          }
          onSend={(text, permission) => {
            void execute(permission, text);
          }}
          onCancel={cancel}
        />
      </section>
      <p id="status" role="status" aria-live="polite">
        {status}
      </p>
      <details
        className="workspace"
        open={editorOpen}
        onToggle={(event) => setEditorOpen(event.currentTarget.open)}
      >
        <summary>JSON scraper</summary>
        <label htmlFor="spec">Specification</label>
        <textarea
          id="spec"
          value={editor}
          onChange={(event) => {
            edited.current = true;
            store.editSpec(event.target.value);
          }}
          disabled={controls.editor}
          rows={16}
          spellCheck={false}
          maxLength={64000}
        />
        <div className="actions">
          <button id="validate" disabled={controls.validate} onClick={validate}>
            Validate JSON
          </button>
          <button
            id="run"
            disabled={controls.run || !source.url}
            onClick={() => {
              void execute(
                browser.permissions.request({
                  origins: [`${source.origin}/*`],
                }),
              );
            }}
          >
            Allow site access and run
          </button>
          <button id="stop" disabled={controls.stop} onClick={cancel}>
            Cancel
          </button>
        </div>
        <p className="hint">
          Runs use a separate tab and stay on the starting site. Limits: 20
          listing pages, 200 items, 220 document visits, one detail level, five
          minutes.
        </p>
      </details>
      <details
        className="workspace"
        open={resultsOpen}
        onToggle={(event) => setResultsOpen(event.currentTarget.open)}
      >
        <summary>Results</summary>
        {exportUrl && !busy ? (
          <a id="export" href={exportUrl} download="scraper-results.json">
            Download JSON results
          </a>
        ) : (
          <button id="export" disabled>
            Download JSON results
          </button>
        )}
        <pre id="results">{result ? resultJson(result) : ""}</pre>
      </details>
    </main>
  );
}

mountPage(<Scraper />);
