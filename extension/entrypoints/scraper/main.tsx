import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { validateSelector } from "../../scraper/selectors";
import { generateScraper } from "../../scraper/agent";
import { dbaListings } from "../../scraper/dba";
import { LIMITS, navigationUrl, parseSpec } from "../../scraper/spec";
import { browserDriver } from "../../scraper/browser";
import { runScraper, resultJson, type Result } from "../../scraper/runner";
import "../settings/style.css";
import "./style.css";

const sourceTab = Number(new URL(location.href).searchParams.get("tab"));
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

function Scraper() {
  const [editor, setEditor] = useState(example);
  const [status, setStatus] = useState(
    "Paste a specification and validate it.",
  );
  const [source, setSource] = useState("Loading source tab…");
  const [startUrl, setStartUrl] = useState("");
  const [validated, setValidated] = useState("");
  const [result, setResult] = useState<Result>();
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [model, setModel] = useState("");
  const [goal, setGoal] = useState("");
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [stopping, setStopping] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const origin = startUrl ? new URL(startUrl).origin : "";
  useEffect(() => {
    let active = true;
    void browser.tabs
      .get(sourceTab)
      .then((tab) => {
        if (!tab.url || tab.incognito)
          throw new Error(
            "Open a regular HTTP(S) marketplace tab and click the extension button.",
          );
        const url = navigationUrl(tab.url, tab.url, new URL(tab.url).origin);
        if (
          ["auth.openai.com", "api.openai.com"].includes(new URL(url).hostname)
        )
          throw new Error("Authentication origins cannot be scraped.");
        if (!active) return;
        setStartUrl(url);
        if (
          new URL(url).hostname === "www.dba.dk" &&
          new URL(url).pathname === "/recommerce/forsale/search"
        ) {
          setEditor(JSON.stringify(dbaListings, null, 2));
          setSource(
            `Source: ${url}. DBA preset follows each listing link and extracts its description. Next-page pagination is not preconfigured; use the agent to configure it when available.`,
          );
        } else
          setSource(
            `Source: ${url}. Example selectors must be replaced for your website.`,
          );
      })
      .catch((error) => {
        if (active) setStatus(errorText(error));
      });
    const close = () => {
      controller.current?.abort();
      void browser.runtime
        .sendMessage({ type: "scraper.agent.cancel" })
        .catch(() => {});
      void browser.runtime
        .sendMessage({ type: "scraper.worker.close" })
        .catch(() => {});
    };
    window.addEventListener("pagehide", close);
    return () => {
      active = false;
      window.removeEventListener("pagehide", close);
      close();
    };
  }, []);

  function validate() {
    try {
      const spec = parseSpec(editor, validateSelector);
      if (!startUrl)
        throw new Error(
          "Source tab unavailable. Open the scraper from a marketplace tab.",
        );
      setValidated(editor);
      setStatus(
        `Valid: ${spec.name}. JSON and CSS syntax accepted; website matches are checked during execution. Approved origin: ${origin}.`,
      );
    } catch (error) {
      setValidated("");
      setStatus(errorText(error));
    }
  }

  async function execute(mode: "run" | "generate") {
    if (controller.current || !startUrl) return;
    if (mode === "run" && (!validated || validated !== editor)) return;
    if (mode === "generate" && (!model || !goal.trim())) {
      setStatus("Describe the data you want to scrape.");
      return;
    }
    // Start the permission request synchronously within the React click handler.
    const permission = browser.permissions.request({
      origins: [`${origin}/*`],
      ...(mode === "generate"
        ? { data_collection: ["websiteContent", "browsingActivity"] }
        : {}),
    });
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setStopping(false);
    setStatus("Requesting site access…");
    if (mode === "run") setResult(undefined);
    else setLog("");
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
      const driver = browserDriver(worker.tab, origin);
      if (mode === "run") {
        const next = await runScraper(
          parseSpec(validated, validateSelector),
          startUrl,
          driver,
          active.signal,
          (progress) => {
            setStatus(
              `${progress.phase}: ${progress.items} items; ${progress.visits} document visits. ${progress.url}`,
            );
          },
        );
        setResult(next);
        setStatus(
          `${next.status}: ${next.stopReason} ${next.items.length} items; ${next.pages.length} document visits.`,
        );
      } else {
        const spec = await generateScraper(
          goal.trim(),
          startUrl,
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
          active.signal,
          (message) => {
            setStatus(message);
            setLog((previous) => previous + message + "\n");
          },
        );
        active.signal.throwIfAborted();
        const json = JSON.stringify(spec, null, 2);
        setEditor(json);
        setValidated(json);
        setStatus(
          `Generated and sample-tested: ${spec.name}. Review the JSON, then run the full scraper. See the agent log for test coverage.`,
        );
      }
    } catch (error) {
      setStatus(active.signal.aborted ? "Cancelled." : errorText(error));
    } finally {
      if (mode === "generate")
        await browser.runtime
          .sendMessage({ type: "scraper.agent.cancel" })
          .catch(() => {});
      if (opened)
        await browser.runtime
          .sendMessage({ type: "scraper.worker.close" })
          .catch(() => {});
      controller.current = undefined;
      setBusy(false);
      setStopping(false);
    }
  }

  async function loadModels() {
    setLoadingModels(true);
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
      setLoadingModels(false);
    }
  }
  function download() {
    if (!result) return;
    const blob = new Blob([resultJson(result)], { type: "application/json" });
    if (blob.size > LIMITS.resultBytes + 500_000) {
      setStatus("Result export exceeds engine limit.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "scraper-results.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <main>
      <h1>Scraper</h1>
      <p>
        <a href="settings.html">Account settings</a> · JSON scraping runs
        locally and requires no sign-in.
      </p>
      <p id="source">{source}</p>
      <p>
        Only the starting page's exact origin is permitted. Firefox will ask for
        site access when you run. A separate tab loads pages using your current
        website session. Keep this page open during the run.
      </p>
      <p>
        Limits: 20 listing pages, 200 items, 220 document visits, one detail
        level, five minutes. Only next-page links are supported.
      </p>
      <fieldset>
        <legend>Generate a scraper with AI</legend>
        <p>
          Sign in and unlock in Account settings, then load models. Generation
          sends rendered page samples and test results to OpenAI. The agent can
          inspect pages, test its JSON, and revise it before returning a
          specification.
        </p>
        <button
          id="load-models"
          disabled={busy || loadingModels}
          onClick={() => void loadModels()}
        >
          Load models
        </button>
        <label htmlFor="agent-model">Model</label>
        <select
          id="agent-model"
          disabled={busy || !models.length}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          {models.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.name}
            </option>
          ))}
        </select>
        <label htmlFor="agent-goal">What should be scraped?</label>
        <textarea
          id="agent-goal"
          rows={3}
          maxLength={4000}
          placeholder="Extract listing titles, prices and links. Follow next pages and extract descriptions from detail pages."
          disabled={busy}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        <button
          id="generate"
          disabled={busy || loadingModels || !model || !startUrl}
          onClick={() => void execute("generate")}
        >
          Allow site access and generate
        </button>
        <pre id="agent-log" aria-live="polite">
          {log}
        </pre>
      </fieldset>
      <label htmlFor="spec">JSON scraping specification</label>
      <textarea
        id="spec"
        rows={22}
        spellCheck={false}
        maxLength={64000}
        disabled={busy}
        value={editor}
        onChange={(event) => {
          setEditor(event.target.value);
          setValidated("");
        }}
      />
      <button id="validate" disabled={busy} onClick={validate}>
        Validate JSON
      </button>
      <button
        id="run"
        disabled={busy || !validated || validated !== editor}
        onClick={() => void execute("run")}
      >
        Allow site access and run
      </button>
      <button
        id="stop"
        disabled={!busy || stopping}
        onClick={() => {
          controller.current?.abort();
          setStopping(true);
          setStatus("Cancelling…");
          void browser.runtime
            .sendMessage({ type: "scraper.agent.cancel" })
            .catch(() => {});
        }}
      >
        Cancel
      </button>
      <p id="status" role="status" aria-live="polite">
        {status}
      </p>
      <button id="export" disabled={busy || !result} onClick={download}>
        Download JSON results
      </button>
      <pre id="results">{result ? resultJson(result) : ""}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Scraper />);
