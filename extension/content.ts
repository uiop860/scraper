import { queryElements, validateSelector } from "./scraper/selectors";
import { inspectPage } from "./scraper/inspect";
import { LIMITS, parseSpec, navigationUrl } from "./scraper/spec";
import { extract, waitForDom, ReadinessError } from "./scraper/dom";

import { probePage, probeSchemas, type ProbeName } from "./scraper/probe";

export function registerContent() {
  const context = globalThis as typeof globalThis & {
    scraperWorkerRegistered?: boolean;
  };
  if (context.scraperWorkerRegistered) return;
  context.scraperWorkerRegistered = true;
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
      !["scraper.extract", "scraper.inspect", "scraper.probe"].includes(
        String(message.type),
      )
    )
      return;
    const task = message as Record<string, unknown>;
    try {
      if (task.type === "scraper.probe") {
        if (
          typeof task.origin !== "string" ||
          typeof task.name !== "string" ||
          !Object.hasOwn(probeSchemas, task.name)
        )
          throw new Error("Invalid probe task.");
        navigationUrl(location.href, location.href, task.origin);
        const controller = new AbortController();
        const unload = () => controller.abort();
        window.addEventListener("pagehide", unload, { once: true });
        try {
          const result = await probePage(
            task.name as ProbeName,
            task.args,
            controller.signal,
          );
          navigationUrl(location.href, location.href, task.origin);
          return { ok: true, result };
        } finally {
          window.removeEventListener("pagehide", unload);
        }
      }
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
          await waitForDom(
            document,
            task.selector === "body" ? undefined : task.selector,
            controller.signal,
          );
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
        // Only expand an unambiguous disclosure inside the selected item description.
        for (const field of Object.values(section.fields)) {
          if (
            !("value" in field) ||
            field.value !== "text" ||
            !field.expandDescription
          )
            continue;
          const containers = queryElements(document, field.selector);
          if (containers.length !== 1) continue;
          const container = containers[0]!;
          if (container.matches("html, body, main, [role=main]")) continue;
          const controls = [
            ...container.querySelectorAll<HTMLElement>(
              'button,[role="button"]',
            ),
          ].filter(
            (button) =>
              !button.closest("a,form,[contenteditable]") &&
              /^(se mere|see more|show more)$/i.test(
                button.textContent?.trim() ?? "",
              ),
          );
          if (controls.length === 1) {
            controls[0]!.click();
            await waitForDom(document, field.selector, controller.signal);
            navigationUrl(location.href, location.href, task.origin);
          }
        }
        const snapshot = extract(document, spec, task.kind, location.href);
        const target = task.kind === "list" && spec.list.scrollToItems;
        if (target && spec.identityField) {
          const rows = new Map<string, (typeof snapshot.items)[number]>();
          let batch = snapshot;
          let bytes = 0;
          let idle = 0;
          for (let attempt = 0; ; attempt++) {
            const before = rows.size;
            for (const row of batch.items) {
              const identity = row[spec.identityField];
              if (typeof identity !== "string" || !identity.trim())
                throw new Error("Scrolling requires a nonempty item identity.");
              if (rows.has(identity)) continue;
              bytes += new TextEncoder().encode(JSON.stringify(row)).length + 1;
              if (bytes > LIMITS.resultBytes)
                throw new Error(
                  "Scrolled results exceeded the result size limit.",
                );
              rows.set(identity, row);
              if (rows.size === target) break;
            }
            idle = rows.size === before ? idle + 1 : 0;
            if (rows.size >= target || idle >= 3 || attempt >= 15) break;
            const cards = queryElements(document, spec.list.itemSelector);
            cards.at(-1)?.scrollIntoView({ block: "end" });
            await new Promise((resolve) => setTimeout(resolve, 600));
            controller.signal.throwIfAborted();
            navigationUrl(location.href, location.href, task.origin);
            batch = extract(document, spec, "list", location.href);
            snapshot.diagnostics.push(
              ...batch.diagnostics.slice(
                0,
                Math.max(0, LIMITS.diagnostics - snapshot.diagnostics.length),
              ),
            );
          }
          snapshot.items = [...rows.values()];
          if (rows.size < target)
            snapshot.diagnostics.unshift({
              code: "scroll_shortfall",
              path: "list.scrollToItems",
              message: `Collected ${rows.size} unique items of ${target} requested.`,
            });
        }
        return { ok: true, snapshot };
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
