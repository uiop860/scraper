import { validateSelector } from "./scraper/selectors";
import { inspectPage } from "./scraper/inspect";
import { parseSpec, navigationUrl } from "./scraper/spec";
import { extract, waitForDom, ReadinessError } from "./scraper/dom";

export function registerContent() {
  // Loaded only into the worker's top frame. There is no window/postMessage bridge.
  browser.runtime.onMessage.addListener(async (message: unknown, sender) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.url?.split("?")[0] !== browser.runtime.getURL("scraper.html")
    )
      return;
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      !["scraper.extract", "scraper.inspect"].includes(String(message.type))
    )
      return;
    const task = message as Record<string, unknown>;
    try {
      if (task.type === "scraper.inspect") {
        if (
          typeof task.origin !== "string" ||
          typeof task.selector !== "string" ||
          !task.selector ||
          task.selector.length > 500
        )
          throw new Error("Invalid inspection task.");
        navigationUrl(location.href, location.href, task.origin);
        const controller = new AbortController();
        const unload = () => controller.abort();
        window.addEventListener("pagehide", unload, { once: true });
        try {
          // Inspection takes a bounded snapshot even when ads or clocks keep changing.
          await waitForDom(document, undefined, controller.signal);
          navigationUrl(location.href, location.href, task.origin);
          return { ok: true, inspection: inspectPage(task.selector) };
        } finally {
          window.removeEventListener("pagehide", unload);
        }
      }
      if (task.kind !== "list" && task.kind !== "detail")
        throw new Error("Invalid extraction task.");
      if (typeof task.origin !== "string") throw new Error("Invalid origin.");
      navigationUrl(location.href, location.href, task.origin);
      const spec = parseSpec(task.spec, validateSelector);
      const section = task.kind === "list" ? spec.list : spec.detail;
      if (!section) throw new Error("Missing detail specification.");
      const controller = new AbortController();
      const unload = () => controller.abort();
      window.addEventListener("pagehide", unload, { once: true });
      try {
        await waitForDom(
          document,
          section.waitFor?.selector ??
            (task.kind === "list" ? spec.list.itemSelector : undefined),
          controller.signal,
        );
        navigationUrl(location.href, location.href, task.origin);
        return {
          ok: true,
          snapshot: extract(document, spec, task.kind, location.href),
        };
      } finally {
        window.removeEventListener("pagehide", unload);
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Extraction failed.",
        diagnostic:
          error instanceof ReadinessError
            ? {
                code: "readiness_timeout",
                path:
                  task.kind === "detail" ? "detail.waitFor" : "list.waitFor",
                selector: error.selector,
                matches: error.matches,
                message: error.message,
              }
            : undefined,
      };
    }
  });
}
