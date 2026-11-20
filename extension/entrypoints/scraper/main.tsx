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
import { ScraperReview, type Review } from "../../scraper/review";
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
      status: "",
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
  const [review, setReview] = useState<Review>();
  const [approved, setApproved] = useState(false);
  const reviewCurrent = review?.json === editor && review?.url === source.url;
  useEffect(() => {
    setApproved(false);
  }, [source.url, source.tab]);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [exportUrl, setExportUrl] = useState("");
  const resultsDialog = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const diagnostics = useRef<{ time: string; event: string; data: unknown }[]>(
    [],
  );
  const diagnosticBytes = useRef(0);
  function trace(event: string, data: unknown) {
    const entry = { time: new Date().toISOString(), event, data };
    const size = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (diagnosticBytes.current + size > 4_000_000) return;
    diagnosticBytes.current += size;
    diagnostics.current.push(entry);
  }
  useEffect(() => {
    if (resultsOpen) resultsDialog.current?.showModal();
    else if (resultsDialog.current?.open) resultsDialog.current.close();
  }, [resultsOpen]);
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
    if (request === undefined && (!reviewCurrent || !approved)) return;
    setCopyStatus("");
    trace("operation.start", {
      operation: request !== undefined ? "generate" : "scrape",
      url: source.url,
      model,
      request,
      spec: editor,
    });
    const controller = new AbortController();
    active.current = controller;
    store.begin(request !== undefined ? "generating" : "scraping");
    setCancelling(false);
    setStatus("Requesting site access…");
    let reply = "";
    let opened = false;
    if (request !== undefined) {
      setApproved(false);
      setReview(undefined);
      setValidated("");
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
      if (
        worker.origin !== source.origin ||
        navigationUrl(worker.startUrl, source.url, source.origin) !== source.url
      )
        throw new Error("Source tab changed. Try again from the desired page.");
      const driver = browserDriver(worker.tab, source.origin);
      if (request !== undefined) {
        let preview: Review["report"] | undefined;
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
            trace("agent.progress", message);
            setStatus(message);
            reviseReply(reply, message);
          },
          trace,
          (report) => {
            preview = report;
          },
        );
        controller.signal.throwIfAborted();
        const json = JSON.stringify(spec, null, 2);
        setEditor(json);
        setValidated(json);
        if (preview)
          setReview({ spec, json, url: source.url, report: preview });
        const message =
          "I scraped a few sample values. Is this the data you wanted? Confirm the samples below, or tell me what to change.";
        setStatus(message);
        reviseReply(reply, message);
      } else {
        const data = await runScraper(
          parseSpec(editor, validateSelector),
          source.url,
          driver,
          controller.signal,
          (progress) =>
            setStatus(
              `Collecting your data… ${progress.items} items collected so far.`,
            ),
        );
        trace("scrape.result", {
          status: data.status,
          stopReason: data.stopReason,
          items: data.items.length,
          pages: data.pages,
        });
        setResult(data);
        setResultsOpen(true);
        setStatus(
          `${data.status === "completed" ? "Finished" : "Stopped"}. Collected ${data.items.length} items from ${data.pages.length} page visits.`,
        );
      }
    } catch (error) {
      const message = controller.signal.aborted
        ? request !== undefined
          ? "Generation cancelled."
          : "Cancelled."
        : errorText(error);
      trace("operation.error", message);
      setStatus(message);
      if (reply) reviseReply(reply, message);
    } finally {
      if (request !== undefined)
        await browser.runtime
          .sendMessage({ type: "scraper.agent.cancel" })
          .catch(() => {});
      if (opened)
        await browser.runtime
          .sendMessage({ type: "scraper.worker.close" })
          .catch(() => {});
      trace("operation.end", { status: store.getState().status });
      active.current = undefined;
      store.finish();
      setCancelling(false);
      void refreshSource();
    }
  }

  return (
    <main>
      <SidebarAccount />
      <div className="toolbar">
        <button
          id="settings"
          aria-label="Open account settings"
          onClick={() => {
            void browser.runtime.openOptionsPage();
          }}
        >
          Settings ↗
        </button>
        <button
          id={operation === "scraping" ? "stop" : "run"}
          disabled={
            operation === "scraping"
              ? controls.stop
              : controls.run || !source.url || !reviewCurrent || !approved
          }
          onClick={() => {
            if (operation === "scraping") {
              cancel();
              return;
            }
            void execute(
              browser.permissions.request({ origins: [`${source.origin}/*`] }),
            );
          }}
        >
          {operation === "scraping" ? "Cancel" : "Run scraper"}
        </button>
        <button disabled={!result || busy} onClick={() => setResultsOpen(true)}>
          JSON output
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void navigator.clipboard
              .writeText(
                JSON.stringify(
                  { version: 1, events: diagnostics.current },
                  null,
                  2,
                ),
              )
              .then(
                () => setCopyStatus(""),
                () =>
                  setCopyStatus("Could not copy diagnostic log. Try again."),
              );
          }}
        >
          Copy diagnostics
        </button>
      </div>
      <p id="status" className="sr-only" role="status" aria-live="polite">
        {copyStatus ||
          (model
            ? status
            : "Choose a model and sign in through Settings to chat.")}
      </p>
      <section id="chat" aria-label="Scraper conversation">
        <Chat
          initialDraft={
            import.meta.env?.DEV
              ? "get all the listings on this page their price and title"
              : ""
          }
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
          review={
            reviewCurrent && review && !approved ? (
              <ScraperReview
                review={review}
                approved={approved}
                disabled={busy}
                onConfirm={() => {
                  setApproved(true);
                  setStatus(
                    "Fields confirmed. Select Run scraper when you’re ready.",
                  );
                }}
                onChange={() => {
                  setApproved(false);
                  setStatus("");
                  setMessages((previous) => [
                    ...previous,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content:
                        "What should I change? Tell me which fields or sample values look wrong, or what’s missing.",
                    },
                  ]);
                  document
                    .querySelector<HTMLTextAreaElement>(".composer textarea")
                    ?.focus();
                }}
              />
            ) : undefined
          }
        />
      </section>
      <dialog
        ref={resultsDialog}
        className="results-dialog"
        aria-labelledby="results-title"
        onClose={() => setResultsOpen(false)}
      >
        <header>
          <h2 id="results-title">JSON output</h2>
          <button type="button" onClick={() => setResultsOpen(false)}>
            Close
          </button>
        </header>
        <pre id="results">{result ? resultJson(result) : ""}</pre>
        {exportUrl && (
          <a id="export" href={exportUrl} download="scraper-results.json">
            Download JSON results
          </a>
        )}
      </dialog>
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
