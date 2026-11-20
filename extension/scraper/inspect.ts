import { elementSelector, queryElements, shadowContexts } from "./selectors";

// Read DOM structure without constructing elements or invoking page code.
export function inspectPage(selector: string) {
  const roots = queryElements(document, selector);
  let remaining = 400;
  let characters = 30_000;
  let truncated = roots.length > 8;
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const copy = (node: Node, depth: number): string => {
    if (--remaining < 0 || characters <= 0 || depth > 10) {
      truncated = true;
      return "";
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node.textContent ?? "").replace(/\s+/g, " ");
      const text = value.slice(0, Math.min(200, characters));
      if (text.length < value.length) truncated = true;
      characters -= text.length;
      return escape(text);
    }
    if (
      !(node instanceof Element) ||
      node.closest(
        "script,style,noscript,iframe,object,input,textarea,select,[contenteditable]",
      )
    )
      return "";
    const tag = node.localName.slice(0, 100);
    let html = `<${tag}`;
    for (const name of [
      "id",
      "class",
      "href",
      "role",
      "aria-label",
      "data-testid",
      "itemprop",
      "alt",
      "src",
      "dir",
      ...(node.matches('meta[property^="og:"],meta[name="description"]')
        ? ["name", "property", "content"]
        : []),
      "title",
    ]) {
      const value = node.getAttribute(name);
      if (value && characters > 0) {
        const part = value.slice(
          0,
          Math.min(name === "class" ? 100 : 300, characters),
        );
        if (part.length < value.length) truncated = true;
        characters -= part.length;
        html += ` ${name}="${escape(part)}"`;
      }
    }
    html += ">";
    for (const child of node.childNodes) {
      if (remaining <= 0 || characters <= 0) {
        truncated = true;
        break;
      }
      html += copy(child, depth + 1);
    }
    return `${html}</${tag}>`;
  };
  const previewText = (element: Element) => {
    const walker = document.createTreeWalker(element, 4);
    const parts: string[] = [];
    let node: Node | null;
    let count = 0;
    while ((node = walker.nextNode()) && ++count <= 200) {
      if (
        !node.parentElement?.closest(
          "script,style,noscript,input,textarea,select,[contenteditable]",
        )
      )
        parts.push(node.textContent ?? "");
      if (parts.join(" ").length > 160) break;
    }
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
  };
  const samples = Array.from(roots)
    .slice(0, 8)
    .map((node) => copy(node, 0));
  // Deep application layouts often exhaust the HTML preview before reaching text.
  // Supply independently bounded text regions with selectors that can be tested.
  let regionBudget = 18_000;
  const textRegions: { selector: string; text: string }[] = [];
  for (const { root } of [
    { root: document },
    ...shadowContexts(document),
  ].slice(0, 8)) {
    const candidates = Array.from(
      root.querySelectorAll(
        "h1,h2,[dir=auto],[itemprop=description],[data-testid*=description]",
      ),
    ).sort(
      (a, b) =>
        Number(!!b.closest("main,[role=main]")) -
        Number(!!a.closest("main,[role=main]")),
    );
    for (const node of candidates) {
      if (textRegions.length >= 60 || regionBudget <= 0) break;
      if (node.closest("script,style,input,textarea,select,[contenteditable]"))
        continue;
      // Prefer the smallest text region to avoid repeated copies of the page.
      if (node.querySelector("[dir=auto]") && !node.matches("h1,h2")) continue;
      const text = (node.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 700);
      if (!text) continue;
      const selector = elementSelector(node);
      if (selector.length > 500) continue;
      const size = selector.length + text.length;
      if (size > regionBudget) continue;
      regionBudget -= size;
      textRegions.push({ selector, text });
    }
  }
  return {
    textRegions,
    url: location.href,
    title: document.title.slice(0, 200),
    matches: roots.length,
    samples,
    shadowRoots: shadowContexts(document)
      .slice(0, 8)
      .map(({ root, prefix }) => ({
        selectorPrefix: prefix,
        headings: Array.from(root.querySelectorAll("h1,h2"))
          .filter(
            (node) => !node.closest("[contenteditable],textarea,input,select"),
          )
          .slice(0, 6)
          .map((node) => ({
            selector: `${prefix}${node.localName}${node.getAttribute("data-testid") ? `[data-testid=${JSON.stringify(node.getAttribute("data-testid"))}]` : ""}`,
            text: previewText(node),
          })),
        regions: Array.from(
          root.querySelectorAll(
            'main,[role="main"],[data-testid*="description"],[itemprop="description"]',
          ),
        )
          .slice(0, 6)
          .map((node) => ({
            selector: `${prefix}${node.localName}${node.getAttribute("data-testid") ? `[data-testid=${JSON.stringify(node.getAttribute("data-testid"))}]` : ""}`,
            text: previewText(node),
          })),
      })),
    truncated,
  };
}
