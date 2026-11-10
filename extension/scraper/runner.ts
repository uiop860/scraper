import { ExtractionError } from "./dom";
import { LIMITS, navigationUrl, parseSpec, type Spec } from "./spec";
import type { Data, Diagnostic, Snapshot } from "./dom";

export interface PageDriver {
  visit(
    url: string,
    kind: "list" | "detail",
    spec: Spec,
    signal: AbortSignal,
  ): Promise<Snapshot>;
  close(): Promise<void>;
}
export interface Item {
  data: Data;
  detail: Data | null;
  source: { list: string; detail?: string };
}
export interface Visit {
  requestedUrl: string;
  url?: string;
  kind: "list" | "detail";
  status: "ok" | "error";
}
export interface Result {
  version: 1;
  name: string;
  startUrl: string;
  origin: string;
  status: "completed" | "limited" | "cancelled" | "failed";
  stopReason: string;
  startedAt: string;
  finishedAt: string;
  items: Item[];
  pages: Visit[];
  diagnostics: (Diagnostic & { url: string })[];
}
export interface Progress {
  phase: string;
  url: string;
  items: number;
  visits: number;
}
export async function runScraper(
  input: unknown,
  start: string,
  driver: PageDriver,
  signal: AbortSignal,
  progress: (p: Progress) => void = () => {},
): Promise<Result> {
  const spec = parseSpec(input);
  const origin = new URL(start).origin;
  const startUrl = navigationUrl(start, start, origin);
  const result: Result = {
    version: 1,
    name: spec.name,
    startUrl,
    origin,
    status: "completed",
    stopReason: "No more listing pages.",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    items: [],
    pages: [],
    diagnostics: [],
  };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LIMITS.durationMs);
  const visited = new Set<string>();
  const identities = new Set<string>();
  const detailCache = new Map<string, { data: Data | null; url: string }>();
  let bytes = 0;
  const diagnostic = (url: string, d: Diagnostic) => {
    if (result.diagnostics.length < LIMITS.diagnostics)
      result.diagnostics.push({ ...d, url });
  };
  const limited = (reason: string): never => {
    result.status = "limited";
    throw new Error(reason);
  };
  const check = () => {
    if (controller.signal.aborted)
      throw new Error(
        timedOut ? "Execution time limit reached." : "Cancelled by user.",
      );
  };
  const visit = async (url: string, kind: "list" | "detail") => {
    check();
    if (result.pages.length >= LIMITS.visits)
      limited("Document visit limit reached.");
    if (visited.has(url)) throw new Error("Document was already visited.");
    visited.add(url);
    const entry: Visit = { requestedUrl: url, kind, status: "error" };
    result.pages.push(entry);
    progress({
      phase: kind,
      url,
      items: result.items.length,
      visits: result.pages.length,
    });
    // Race every driver operation against cancellation; a stuck browser call cannot hold the run open.
    const snapshot = await new Promise<Snapshot>((resolve, reject) => {
      const abort = () => reject(new Error("Navigation cancelled."));
      controller.signal.addEventListener("abort", abort, { once: true });
      if (controller.signal.aborted) abort();
      Promise.resolve()
        .then(() => driver.visit(url, kind, spec, controller.signal))
        .then(resolve, (error: unknown) => {
          if (error instanceof ExtractionError && error.diagnostic)
            diagnostic(url, error.diagnostic);
          reject(error);
        })
        .finally(() => controller.signal.removeEventListener("abort", abort));
    });
    check();
    const actual = navigationUrl(snapshot.url, url, origin);
    if (actual !== url && visited.has(actual))
      throw new Error("Redirect led to a previously visited document.");
    visited.add(actual);
    entry.url = actual;
    entry.status = "ok";
    for (const d of snapshot.diagnostics) diagnostic(actual, d);
    return { ...snapshot, url: actual };
  };
  try {
    let next: string | null = startUrl;
    let listings = 0;
    while (next) {
      check();
      if (listings >= LIMITS.pages) limited("Listing page limit reached.");
      if (visited.has(next)) {
        diagnostic(next, {
          code: "pagination_cycle",
          path: "pagination",
          message: "Repeated page skipped.",
        });
        break;
      }
      const page = await visit(next, "list");
      listings++;
      for (const data of page.items) {
        check();
        const link = spec.detail ? data[spec.detail.linkField] : undefined;
        let detailUrl: string | undefined;
        if (typeof link === "string") {
          try {
            detailUrl = navigationUrl(link, page.url, origin);
          } catch {
            diagnostic(page.url, {
              code: "blocked_detail",
              path: "detail",
              message: "Detail URL is outside the approved origin or invalid.",
            });
          }
        }
        const id = spec.identityField
          ? data[spec.identityField]
          : (detailUrl ?? data);
        const identity = JSON.stringify(id ?? data);
        if (identities.has(identity)) continue;
        if (result.items.length >= LIMITS.items) limited("Item limit reached.");
        identities.add(identity);
        const item: Item = { data, detail: null, source: { list: page.url } };
        // Retain listing data even when detail extraction fails or is cancelled.
        const size = new TextEncoder().encode(JSON.stringify(item)).length;
        if (bytes + size > LIMITS.resultBytes)
          limited("Result size limit reached.");
        bytes += size;
        result.items.push(item);
        if (spec.detail && detailUrl) {
          try {
            let detail = detailCache.get(detailUrl);
            if (!detail) {
              const snapshot = await visit(detailUrl, "detail");
              detail = { data: snapshot.items[0] ?? null, url: snapshot.url };
              detailCache.set(detailUrl, detail);
              detailCache.set(snapshot.url, detail);
            }
            const extra = new TextEncoder().encode(
              JSON.stringify(detail),
            ).length;
            if (bytes + extra > LIMITS.resultBytes)
              limited("Result size limit reached.");
            bytes += extra;
            item.detail = detail.data;
            item.source.detail = detail.url;
          } catch (error) {
            check();
            if (result.status === "limited") throw error;
            detailCache.set(detailUrl, { data: null, url: detailUrl });
            diagnostic(detailUrl, {
              code: "detail_failed",
              path: "detail",
              message:
                error instanceof Error
                  ? error.message
                  : "Detail extraction failed.",
            });
          }
        } else if (spec.detail && !detailUrl)
          diagnostic(page.url, {
            code: "missing_detail",
            path: "detail",
            message: "No permitted detail URL for this item.",
          });
        progress({
          phase: "extracted",
          url: page.url,
          items: result.items.length,
          visits: result.pages.length,
        });
      }
      next = page.next ? navigationUrl(page.next, page.url, origin) : null;
    }
  } catch (error) {
    if (controller.signal.aborted)
      result.status = timedOut ? "limited" : "cancelled";
    else if (result.status !== "limited") result.status = "failed";
    result.stopReason = controller.signal.aborted
      ? timedOut
        ? "Execution time limit reached."
        : "Cancelled by user."
      : error instanceof Error
        ? error.message
        : "Execution failed.";
    diagnostic(startUrl, {
      code: result.status,
      path: "run",
      message: result.stopReason,
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort();
    try {
      await driver.close();
    } catch {
      diagnostic(startUrl, {
        code: "cleanup_failed",
        path: "run",
        message: "Worker cleanup failed. Close its tab manually.",
      });
    }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}
