// >>> is an explicit boundary into an element's open shadow root. Each segment
// is ordinary CSS; quoted attribute values and escaped > characters stay intact.
export function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "/" && selector[i + 1] === "*") {
      const end = selector.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unclosed selector comment.");
      i = end + 1;
      continue;
    }
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth--;
    if (!depth && selector.slice(i, i + 3) === ">>>") {
      parts.push(selector.slice(start, i).trim());
      start = i + 3;
      i += 2;
    }
  }
  parts.push(selector.slice(start).trim());
  if (parts.length > 8 || parts.some((part) => !part))
    throw new Error("Invalid shadow selector boundary.");
  return parts;
}
export function validateSelector(selector: string, doc: Document = document) {
  for (const part of selectorParts(selector)) doc.querySelector(part);
}
export function queryElements(
  root: ParentNode,
  selector: string,
  observe?: (root: ParentNode) => void,
): Element[] {
  let roots = [root];
  const parts = selectorParts(selector);
  for (let i = 0; i < parts.length; i++) {
    const nodes: Element[] = [];
    for (const scope of roots) {
      observe?.(scope);
      if (parts[i] === ":scope" && scope.nodeType === 1)
        nodes.push(scope as Element);
      else nodes.push(...scope.querySelectorAll(parts[i]));
    }
    if (i === parts.length - 1) return [...new Set(nodes)];
    if (nodes.length > 200)
      throw new Error("Shadow selector exceeds 200 hosts.");
    roots = nodes.flatMap((node) => (node.shadowRoot ? [node.shadowRoot] : []));
  }
  return [];
}

export function shadowContexts(doc: Document) {
  const contexts: { root: ParentNode; prefix: string }[] = [
    { root: doc, prefix: "" },
  ];
  let scanned = 0;
  for (let i = 0; i < contexts.length && contexts.length <= 40; i++) {
    const { root, prefix } = contexts[i];
    for (const node of root.querySelectorAll("*")) {
      if (++scanned > 10_000 || contexts.length > 40) return contexts.slice(1);
      if (!node.shadowRoot) continue;
      // A full structural path disambiguates repeated custom elements.
      const path: string[] = [];
      let current: Element | null = node;
      while (current) {
        const siblings: Element[] = Array.from(
          current.parentNode?.children ?? [],
        ).filter((sibling) => sibling.localName === current!.localName);
        path.unshift(
          `${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`,
        );
        current = current.parentElement;
      }
      contexts.push({
        root: node.shadowRoot,
        prefix: `${prefix}${path.join(" > ")} >>> `,
      });
    }
  }
  return contexts.slice(1);
}
