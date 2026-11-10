import { LIMITS, type Fields, type Spec } from "./spec";
export type Value = string | null | Value[] | { [key: string]: Value };
export type Data = Record<string, Value>;
export interface Diagnostic {
  code: string;
  path: string;
  selector?: string;
  matches?: number;
  message: string;
}
export interface Snapshot {
  url: string;
  items: Data[];
  next: string | null;
  diagnostics: Diagnostic[];
}

export function extract(
  doc: Document,
  spec: Spec,
  kind: "list" | "detail",
  url: string,
): Snapshot {
  const diagnostics: Diagnostic[] = [];
  let budget = LIMITS.resultBytes;
  let operations = 0;
  const report = (d: Diagnostic) => {
    if (diagnostics.length < LIMITS.diagnostics) diagnostics.push(d);
  };
  const matches = (
    root: ParentNode,
    selector: string,
    path: string,
  ): Element[] => {
    try {
      const nodes =
        selector === ":scope" && root.nodeType === 1
          ? [root as Element]
          : Array.from(root.querySelectorAll(selector));
      if (nodes.length > LIMITS.matches)
        report({
          code: "match_limit",
          path,
          selector,
          matches: nodes.length,
          message: "Matches truncated to engine limit.",
        });
      return nodes.slice(0, LIMITS.matches);
    } catch {
      report({
        code: "invalid_selector",
        path,
        selector,
        message: "Invalid CSS selector.",
      });
      return [];
    }
  };
  const read = (root: ParentNode, fields: Fields, prefix: string): Data =>
    Object.fromEntries(
      Object.entries(fields).map(([key, rule]) => {
        if (++operations > 10_000)
          throw new Error("Nested extraction exceeded the operation limit.");
        const path = `${prefix}.${key}`;
        const nodes = matches(root, rule.selector, path);
        if (!nodes.length && !rule.optional)
          report({
            code: "missing",
            path,
            selector: rule.selector,
            matches: 0,
            message: "Required field did not match.",
          });
        const values = (rule.multiple ? nodes : nodes.slice(0, 1)).map(
          (node): Value => {
            if ("fields" in rule) return read(node, rule.fields, path);
            let value =
              rule.value === "text"
                ? (node.textContent ?? "").replace(/\s+/g, " ").trim()
                : node.getAttribute(rule.attribute);
            if (value === null) {
              if (!rule.optional)
                report({
                  code: "missing_attribute",
                  path,
                  selector: rule.selector,
                  message: "Attribute is missing.",
                });
              return null;
            }
            if (rule.value === "attribute" && rule.resolveUrl) {
              try {
                // Use the actual document URL, never an untrusted <base> element.
                const resolved = new URL(value, url);
                if (
                  !["https:", "http:"].includes(resolved.protocol) ||
                  resolved.username ||
                  resolved.password
                )
                  throw new Error();
                value = resolved.href;
              } catch {
                report({
                  code: "invalid_url",
                  path,
                  selector: rule.selector,
                  message: "Attribute is not an HTTP(S) URL.",
                });
                return null;
              }
            }
            if (value.length > LIMITS.stringLength)
              report({
                code: "string_limit",
                path,
                selector: rule.selector,
                message: "Value truncated to engine limit.",
              });
            value = value.slice(0, LIMITS.stringLength);
            budget -= value.length * 6; // Conservative JSON encoding budget, including escapes.
            if (budget < 0)
              throw new Error(
                "Page extraction exceeded the result size limit.",
              );
            return value;
          },
        );
        return [key, rule.multiple ? values : (values[0] ?? null)];
      }),
    );
  const section = kind === "list" ? spec.list : spec.detail;
  if (!section) throw new Error("No detail extraction specified.");
  const roots: ParentNode[] =
    kind === "list" ? matches(doc, spec.list.itemSelector, "list") : [doc];
  if (!roots.length)
    report({
      code: "empty_list",
      path: "list",
      selector: spec.list.itemSelector,
      matches: 0,
      message: "No items matched.",
    });
  let next: string | null = null;
  if (kind === "list" && spec.pagination) {
    const node = matches(doc, spec.pagination.selector, "pagination")[0];
    next = node?.getAttribute("href") ?? null;
    if (node && !next)
      report({
        code: "missing_next_href",
        path: "pagination",
        selector: spec.pagination.selector,
        message:
          "Next-page element has no href; clickable pagination is unsupported.",
      });
  }
  return {
    url,
    items: roots.map((root, i) => read(root, section.fields, `${kind}[${i}]`)),
    next,
    diagnostics,
  };
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: Diagnostic,
  ) {
    super(message);
  }
}

export class ReadinessError extends Error {
  constructor(
    message: string,
    readonly selector: string | undefined,
    readonly matches: number,
  ) {
    super(message);
    this.name = "ReadinessError";
  }
}

export function waitForDom(
  doc: Document,
  selector: string | undefined,
  signal: AbortSignal,
  timeout = LIMITS.waitMs,
  settle = LIMITS.settleMs,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let roots: Element[] = [];
    let finished = false;
    const cleanup = () => {
      observer.disconnect();
      clearTimeout(deadline);
      clearTimeout(quiet);
      signal.removeEventListener("abort", abort);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Cancelled."));
    const check = (records: MutationRecord[] = []) => {
      try {
        const next = selector
          ? Array.from(doc.querySelectorAll(selector)).slice(0, LIMITS.matches)
          : [];
        const changed =
          next.length !== roots.length ||
          next.some((node, i) => node !== roots[i]);
        // Ads, clocks and unrelated application updates must not starve readiness.
        const relevant = records.some((record) =>
          next.some(
            (node) =>
              node === record.target ||
              node.contains(record.target) ||
              Array.from(record.addedNodes).some((added) =>
                node.contains(added),
              ),
          ),
        );
        roots = next;
        if (selector && !roots.length) {
          clearTimeout(quiet);
          quiet = undefined;
          return;
        }
        if (quiet === undefined || changed || relevant) {
          clearTimeout(quiet);
          quiet = setTimeout(() => finish(), settle);
        }
      } catch {
        finish(new ReadinessError("Invalid readiness selector.", selector, 0));
      }
    };
    const observer = new (
      doc.defaultView?.MutationObserver ?? MutationObserver
    )(check);
    const deadline = setTimeout(() => {
      const message = roots.length
        ? `DOM readiness timed out: selector ${JSON.stringify(selector)} matched ${roots.length} elements, but their content kept changing.`
        : `DOM readiness timed out: selector ${JSON.stringify(selector)} matched 0 elements. Check the selector, consent screen or access challenge.`;
      finish(new ReadinessError(message, selector, roots.length));
    }, timeout);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    observer.observe(doc, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    check();
  });
}
