import type { inspectPage } from "./inspect";
import type { PageDriver } from "./runner";
import { ExtractionError, type Snapshot, type Diagnostic } from "./dom";
import { LIMITS, navigationUrl, type Spec } from "./spec";

import type { ProbeName, ProbeArgs } from "./probe";

export function browserDriver(
  tab: number,
  origin: string,
): PageDriver & {
  probe(
    url: string,
    name: ProbeName,
    args: ProbeArgs,
    signal: AbortSignal,
  ): Promise<unknown>;
  inspect(
    url: string,
    selector: string,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof inspectPage>>;
} {
  let closed = false;
  async function load(url: string, signal: AbortSignal, reuse = false) {
    if (closed) throw new Error("Worker closed.");
    navigationUrl(url, url, origin);
    signal.throwIfAborted();
    const previous = reuse ? await browser.tabs.get(tab) : undefined;
    const sameDocument = (left: string, right: string) => {
      const a = new URL(left);
      const b = new URL(right);
      if (
        a.origin === b.origin &&
        /(^|\.)facebook\.com$/.test(a.hostname) &&
        /^\/marketplace\/item\/\d+\/?$/.test(a.pathname)
      ) {
        return a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
      }
      return a.href === b.href;
    };
    if (!(
      previous?.url &&
      sameDocument(previous.url, url) &&
      previous.status === "complete"
    ))
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          browser.tabs.onUpdated.removeListener(updated);
          browser.tabs.onRemoved.removeListener(removed);
          signal.removeEventListener("abort", abort);
        };
        const done = (error?: Error) => {
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const abort = () => done(new Error("Cancelled."));
        const removed = (id: number) => {
          if (id === tab) done(new Error("Worker tab closed."));
        };
        const updated = (
          id: number,
          change: browser.tabs._OnUpdatedChangeInfo,
          updatedTab: browser.tabs.Tab,
        ) => {
          if (id !== tab) return;
          if (change.url) {
            try {
              navigationUrl(change.url, url, origin);
            } catch {
              done(new Error("Off-origin navigation blocked."));
              return;
            }
          }
          if (
            change.status === "complete" &&
            updatedTab.url &&
            updatedTab.url !== "about:blank"
          )
            done();
        };
        const timer = setTimeout(
          () => done(new Error("Page navigation timed out or was blocked.")),
          LIMITS.waitMs,
        );
        browser.tabs.onUpdated.addListener(updated);
        browser.tabs.onRemoved.addListener(removed);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        void browser.tabs
          .update(tab, { url })
          .catch(() => done(new Error("Could not navigate worker tab.")));
      });
    signal.throwIfAborted();
    const current = await browser.tabs.get(tab);
    if (!current.url) throw new Error("Worker URL unavailable.");
    navigationUrl(current.url, url, origin);
    if (
      previous?.url &&
      !sameDocument(previous.url, url) &&
      current.url === previous.url
    )
      throw new Error("Navigation did not leave the previous page.");

    // A URL does not identify a document: same-URL reloads discard listeners.
    // Registration is idempotent, so refresh it even when navigation is reused.
    await browser.scripting.executeScript({
      target: { tabId: tab, frameIds: [0] },
      files: ["scraper-worker.js"],
    });
    signal.throwIfAborted();
  }
  return {
    async probe(url, name, args, signal) {
      await load(url, signal, true);
      const response = (await browser.tabs.sendMessage(
        tab,
        { type: "scraper.probe", origin, name, args },
        { frameId: 0 },
      )) as { ok: boolean; result?: unknown; error?: string } | undefined;
      signal.throwIfAborted();
      if (!response?.ok)
        throw new Error(response?.error ?? "Page probe unavailable.");
      navigationUrl((await browser.tabs.get(tab)).url ?? "", url, origin);
      return response.result;
    },
    async inspect(url, selector, signal) {
      await load(url, signal, true);
      const response = (await browser.tabs.sendMessage(
        tab,
        { type: "scraper.inspect", origin, selector },
        { frameId: 0 },
      )) as
        | {
            ok: boolean;
            inspection?: ReturnType<typeof inspectPage>;
            error?: string;
          }
        | undefined;
      signal.throwIfAborted();
      const result = response?.inspection;
      if (!response?.ok || !result)
        throw new Error(response?.error ?? "Page inspection unavailable.");
      navigationUrl(result.url, url, origin);
      return result;
    },
    async visit(
      url: string,
      kind: "list" | "detail",
      spec: Spec,
      signal: AbortSignal,
    ): Promise<Snapshot> {
      await load(url, signal, true);
      const response = (await browser.tabs.sendMessage(
        tab,
        { type: "scraper.extract", spec, kind, origin },
        { frameId: 0 },
      )) as
        | {
            ok: boolean;
            error?: string;
            snapshot?: Snapshot;
            diagnostic?: Diagnostic;
          }
        | undefined;
      signal.throwIfAborted();
      if (!response?.ok || !response.snapshot)
        throw new ExtractionError(
          response?.error ?? "Page extraction unavailable.",
          response?.diagnostic,
        );
      navigationUrl(response.snapshot.url, url, origin);
      return response.snapshot;
    },
    async close() {
      if (closed) return;
      closed = true;
      const response = await browser.runtime.sendMessage({
        type: "scraper.worker.close",
      });
      if (!response?.ok) throw new Error("Could not close worker.");
    },
  };
}
