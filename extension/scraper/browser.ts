import type { PageDriver } from "./runner";
import { ExtractionError, type Snapshot, type Diagnostic } from "./dom";
import { LIMITS, navigationUrl, type Spec } from "./spec";

export function browserDriver(tab: number, origin: string): PageDriver {
  let closed = false;
  return {
    async visit(
      url: string,
      kind: "list" | "detail",
      spec: Spec,
      signal: AbortSignal,
    ): Promise<Snapshot> {
      if (closed) throw new Error("Worker closed.");
      navigationUrl(url, url, origin);
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
      await browser.scripting.executeScript({
        target: { tabId: tab, frameIds: [0] },
        files: ["content.js"],
      });
      signal.throwIfAborted();
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
