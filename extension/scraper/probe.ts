import { z } from "./schema";
import { elementSelector, queryElements, shadowContexts } from "./selectors";
import { LIMITS } from "./spec";

const selector = z.string().min(1).max(500);
const url = z.string().max(8192);
export const probeSchemas = {
  search_text: z.strictObject({ url, text: z.string().min(1).max(500) }),
  inspect_element: z.strictObject({ url, selector }),
  wait_for_content: z.strictObject({
    url,
    selector,
    text: z.string().max(500),
    absentSelector: z.string().max(500),
  }),
  expand_disclosure: z.strictObject({ url, selector }),
  compare_fields: z.strictObject({
    url,
    itemSelector: selector,
    fields: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(64),
          selector,
          attribute: z.string().max(100),
        }),
      )
      .min(1)
      .max(20),
  }),
};
export type ProbeName = keyof typeof probeSchemas;
export type ProbeArgs = z.infer<(typeof probeSchemas)[ProbeName]>;

const blocked = "script,style,noscript,input,textarea,select,[contenteditable]";
function text(element: Element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let value = "";
  let node: Node | null;
  while ((node = walker.nextNode()) && value.length < 2000) {
    if (!node.parentElement?.closest(blocked)) value += node.textContent ?? "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}
function describe(element: Element) {
  return {
    selector: elementSelector(element),
    tag: element.localName,
    attributes: Object.fromEntries(
      [
        "id",
        "role",
        "aria-label",
        "dir",
        "href",
        "src",
        "data-testid",
        "itemprop",
      ].flatMap((name) =>
        element.hasAttribute(name)
          ? [[name, element.getAttribute(name)!.slice(0, 500)]]
          : [],
      ),
    ),
    text: text(element),
    truncated: (element.textContent?.length ?? 0) > 1000,
  };
}
export async function probePage(
  name: ProbeName,
  input: unknown,
  signal: AbortSignal,
) {
  const args = probeSchemas[name].parse(input);
  if (name === "search_text" && "text" in args) {
    const matches = [];
    let scanned = 0;
    for (const { root } of [{ root: document }, ...shadowContexts(document)]) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while (
        (node = walker.nextNode()) &&
        scanned++ < 20_000 &&
        matches.length < 20
      ) {
        const element = node.parentElement;
        if (
          element &&
          !element.closest(blocked) &&
          node.textContent
            ?.toLocaleLowerCase()
            .includes(args.text.toLocaleLowerCase())
        )
          matches.push({
            element: describe(element),
            parent: element.parentElement
              ? describe(element.parentElement)
              : null,
          });
      }
    }
    return {
      url: location.href,
      matches,
      truncated: scanned >= 20_000 || matches.length === 20,
    };
  }
  if (name === "compare_fields" && "fields" in args) {
    const items = queryElements(document, args.itemSelector);
    return {
      url: location.href,
      count: items.length,
      samples: items.slice(0, 3).map((item) =>
        args.fields.map((field) => {
          const nodes = queryElements(item, field.selector);
          return {
            name: field.name,
            matches: nodes.length,
            sources: nodes.slice(0, 2).map((node) => ({
              ...describe(node),
              value: field.attribute
                ? (node.getAttribute(field.attribute)?.slice(0, 1000) ?? null)
                : text(node),
            })),
          };
        }),
      ),
    };
  }
  if (!("selector" in args)) throw new Error("Missing selector.");
  if (name === "wait_for_content") {
    const condition = probeSchemas.wait_for_content.parse(input);
    const deadline = Date.now() + LIMITS.waitMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const nodes = queryElements(document, args.selector);
      if (
        nodes.some(
          (node) =>
            text(node).length > 0 && text(node).includes(condition.text),
        ) &&
        (!condition.absentSelector ||
          !queryElements(document, condition.absentSelector).length)
      )
        return {
          url: location.href,
          matches: nodes.length,
          samples: nodes.slice(0, 3).map(describe),
        };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "Content readiness timed out. Required text or loading-state condition was not met.",
    );
  }
  const nodes = queryElements(document, args.selector);
  if (name === "expand_disclosure") {
    if (nodes.length !== 1)
      throw new Error("Select exactly one disclosure button.");
    const node = nodes[0]!;
    if (
      !(node instanceof HTMLElement) ||
      !node.matches('button,[role="button"]') ||
      node.closest("a,form,[contenteditable]") ||
      !/^(se mere|see more|show more)$/i.test(text(node))
    )
      throw new Error(
        "Only a Se mere, See more or Show more disclosure button can be expanded.",
      );
    const container = node.parentElement;
    node.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    signal.throwIfAborted();
    return {
      url: location.href,
      parent: container?.isConnected ? describe(container) : null,
    };
  }
  return {
    url: location.href,
    matches: nodes.length,
    samples: nodes.slice(0, 3).map((node) => ({
      element: describe(node),
      parent: node.parentElement ? describe(node.parentElement) : null,
      children: Array.from(node.children).slice(0, 8).map(describe),
      siblings: node.parentElement
        ? Array.from(node.parentElement.children)
            .filter((child) => child !== node)
            .slice(0, 8)
            .map(describe)
        : [],
    })),
  };
}
