import { selectorParts } from "./selectors";
import type { Fields, Spec } from "./spec";

export type PageReviewResult =
  | { status: "confirmed" }
  | { status: "rejected"; field: string }
  | { status: "dismissed" }
  | { status: "unavailable"; field: string };

type Target = { label: string; path: string[][] };
export function reviewTargets(
  fields: Fields,
  path: string[][] = [],
  prefix = "",
): Target[] {
  return Object.entries(fields).flatMap(([name, field]) => {
    const next = [...path, selectorParts(field.selector)];
    const label = `${prefix}${name}`;
    return "fields" in field
      ? reviewTargets(field.fields, next, `${label} / `)
      : [{ label, path: next }];
  });
}

// This function runs in the page's isolated extension world. Keep it self-contained.
export async function highlightExample(
  item: string[],
  targets: Target[],
): Promise<PageReviewResult> {
  const page = window as Window & { __scraperReviewCleanup?: () => void };
  page.__scraperReviewCleanup?.();
  function query(root: ParentNode, parts: string[]): Element[] {
    let roots = [root];
    for (let index = 0; index < parts.length; index++) {
      const nodes: Element[] = roots.flatMap((scope) =>
        parts[index] === ":scope" && scope.nodeType === 1
          ? [scope as Element]
          : Array.from(scope.querySelectorAll(parts[index]!)),
      );
      if (index === parts.length - 1) return nodes;
      roots = nodes.flatMap((node) =>
        node.shadowRoot ? [node.shadowRoot] : [],
      );
    }
    return [];
  }
  const example = query(document, item)[0];
  if (!example || !targets.length)
    return { status: "unavailable", field: "example listing" };
  return new Promise((resolve) => {
    let index = 0;
    let selected: Element | undefined;
    let ended = false;
    const host = document.createElement("div");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; }
      .outline { position: fixed; border: 3px solid #5684ff; border-radius: 5px; background: #5684ff20; pointer-events: none; }
      .panel { position: fixed; pointer-events: auto; width: min(340px, calc(100vw - 24px)); padding: 14px; border: 1px solid #526481; border-radius: 12px; background: #202329; color: #f4f6ff; box-shadow: 0 8px 30px #0006; font: 14px/1.5 system-ui,sans-serif; }
      p { margin: 0 0 10px; overflow-wrap: anywhere; }
      .actions { display: flex; gap: 8px; }
      button { cursor: pointer; padding: 7px 12px; border: 1px solid #69758b; border-radius: 7px; background: #303845; color: white; font: inherit; }
      button:focus-visible { outline: 2px solid white; outline-offset: 2px; }
      .yes { background: #245b40; } .no { background: #793537; }
      .close { margin-left: auto; }
    `;
    const outline = document.createElement("div");
    outline.className = "outline";
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Confirm the highlighted field");
    const title = document.createElement("p");
    const actions = document.createElement("div");
    actions.className = "actions";
    function button(label: string, className: string, action: () => void) {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.className = className;
      element.addEventListener("click", action);
      actions.append(element);
      return element;
    }
    const yes = button("✓ Correct", "yes", () => {
      if (!selected?.isConnected) {
        finish({ status: "unavailable", field: targets[index]!.label });
        return;
      }
      index++;
      if (index === targets.length) finish({ status: "confirmed" });
      else show();
    });
    button("✕ Wrong", "no", () =>
      finish({ status: "rejected", field: targets[index]!.label }),
    );
    button("Close", "close", () => finish({ status: "dismissed" }));
    panel.append(title, actions);
    root.append(style, outline, panel);
    document.documentElement.append(host);
    const previous = document.activeElement;
    const timer = setTimeout(() => finish({ status: "dismissed" }), 120_000);
    function finish(result: PageReviewResult) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("pagehide", dismiss);
      window.removeEventListener("keydown", keydown, true);
      host.remove();
      delete page.__scraperReviewCleanup;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
      resolve(result);
    }
    function dismiss() {
      finish({ status: "dismissed" });
    }
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    }
    function position() {
      if (!selected?.isConnected) {
        finish({ status: "unavailable", field: targets[index]!.label });
        return;
      }
      const rect = selected.getBoundingClientRect();
      outline.style.cssText = `left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px`;
      const width = panel.getBoundingClientRect().width;
      const height = panel.getBoundingClientRect().height;
      panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      const below = rect.bottom + 10;
      panel.style.top = `${Math.max(12, Math.min(below + height < window.innerHeight - 12 ? below : rect.top - height - 10, window.innerHeight - height - 12))}px`;
    }
    function show() {
      let node: ParentNode = example!;
      for (const parts of targets[index]!.path) {
        const match = query(node, parts)[0];
        if (!match) {
          finish({ status: "unavailable", field: targets[index]!.label });
          return;
        }
        node = match;
      }
      selected = node as Element;
      if (!selected.getClientRects().length) {
        finish({ status: "unavailable", field: targets[index]!.label });
        return;
      }
      selected.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
      title.textContent = `${index + 1} of ${targets.length} · Is the highlighted element the ${targets[index]!.label.replaceAll("_", " ")} you want?`;
      position();
      yes.focus({ preventScroll: true });
    }
    page.__scraperReviewCleanup = dismiss;
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    window.addEventListener("pagehide", dismiss);
    window.addEventListener("keydown", keydown, true);
    show();
  });
}

export async function reviewPage(tab: number, spec: Spec) {
  const results = await browser.scripting.executeScript({
    target: { tabId: tab, frameIds: [0] },
    func: highlightExample,
    args: [
      selectorParts(spec.list.itemSelector),
      reviewTargets(spec.list.fields),
    ],
  });
  return results[0]?.result as PageReviewResult | undefined;
}

export function dismissPageReview() {
  (
    window as Window & { __scraperReviewCleanup?: () => void }
  ).__scraperReviewCleanup?.();
}
