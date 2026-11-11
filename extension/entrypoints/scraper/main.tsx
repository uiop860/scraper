import { SidebarAccount } from "../../scraper/account";
import { createPreferencesStore } from "../../state/preferences";
import "./style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { mountPage } from "../../ui/root";
import { useStore } from "zustand";
import { createScraperStore, scraperControls } from "../../state/scraper";
import { storeField } from "../../state/field";
import { Chat } from "../../scraper/chat";
import { validateSelector } from "../../scraper/selectors";
import { generateScraper } from "../../scraper/agent";
import { LIMITS, navigationUrl, parseSpec } from "../../scraper/spec";
import { browserDriver } from "../../scraper/browser";
import { runScraper, resultJson } from "../../scraper/runner";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Scraping failed.";
type Source = { tab?: number; url: string; origin: string; label: string };
const emptySource: Source = {
  url: "",
  origin: "",
  label: "Loading active tab…",
};

function Scraper() {
  const [preferences] = useState(createPreferencesStore);
  const model = useStore(preferences, (state) => state.model);
  const [store] = useState(() => {
    const store = createScraperStore("");
    store.setState({
      source: emptySource.label,
      status: "Describe the data you want to extract.",
    });
    return store;
  });
  const snapshot = useStore(store);
  const { spec: editor, status, result, messages, busy: operation } = snapshot;
  const source: Source = {
    tab: snapshot.sourceTab,
    url: snapshot.startUrl,
    origin: snapshot.origin,
    label: snapshot.source,
  };
  const busy = operation === "scraping" || operation === "generating";
  const controls = scraperControls({ ...snapshot, model });
  const setEditor = storeField(store, "spec");
  const setValidated = storeField(store, "validated");
  const setStatus = storeField(store, "status");
  const setResult = storeField(store, "result");
  const setMessages = storeField(store, "messages");
  const setCancelling = storeField(store, "cancelling");
  const [workerTab, setWorkerTab] = useState<number>();
  const [resultsOpen, setResultsOpen] = useState(false);
  const [exportUrl, setExportUrl] = useState("");
  const active = useRef<AbortController | undefined>(undefined);
  const windowId = useRef<number | undefined>(undefined);
  const live = useRef(false);
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
      if (request !== undefined) {
        const catalog = await browser.runtime.sendMessage({
          type: "scraper.agent.models",
        });
        controller.signal.throwIfAborted();
        if (!catalog?.ok)
          throw new Error(
            catalog?.error ?? "Models unavailable. Check Settings.",
          );
        if (
          !catalog.models.some((choice: { id: string }) => choice.id === model)
        )
          throw new Error(
            "The saved model is unavailable. Choose another model in Settings.",
          );
      }
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
          editor
            ? `${request}\nCurrent scraper to revise:\n${editor}`
            : request,
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
        setEditor(json);
        setValidated(json);
        const message = `Ready: ${spec.name}. Select Run scraper to collect the full results.`;
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
            View working tab ↗
          </button>
        )}
      </section>
      <SidebarAccount />
      <p className="hint">
        {model ? `Model: ${model}.` : "Choose a model in Settings."} Sign in
        through Settings to chat.
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
      <div className="actions">
        <button
          id="run"
          disabled={controls.run || !source.url}
          onClick={() => {
            void execute(
              browser.permissions.request({ origins: [`${source.origin}/*`] }),
            );
          }}
        >
          Run scraper
        </button>
        <button id="stop" disabled={controls.stop} onClick={cancel}>
          Cancel
        </button>
      </div>
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

async function startSidebar() {
  const window = await browser.windows.getCurrent();
  if (window.incognito || window.id === undefined) return;
  if (new URL(location.href).searchParams.get("window") !== String(window.id)) {
    location.replace(
      browser.runtime.getURL(`scraper.html?window=${window.id}`),
    );
    return;
  }
  mountPage(<Scraper />);
}

void startSidebar().catch(() => {
  const root = document.getElementById("root");
  if (root) root.textContent = "Could not open the sidebar. Please reopen it.";
});
