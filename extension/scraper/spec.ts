import { z } from "zod";

export const LIMITS = Object.freeze({
  pages: 20,
  items: 200,
  visits: 220,
  durationMs: 300_000,
  waitMs: 15_000,
  settleMs: 400,
  specBytes: 64_000,
  depth: 5,
  fields: 100,
  matches: 200,
  stringLength: 10_000,
  resultBytes: 5_000_000,
  diagnostics: 300,
});
const selector = z.string().trim().min(1).max(500);
const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine((s) => !["constructor", "prototype", "__proto__"].includes(s));
const common = {
  selector,
  optional: z.boolean().optional(),
  multiple: z.boolean().optional(),
};
const leaf = z.union([
  z.strictObject({ ...common, value: z.literal("text") }),
  z.strictObject({
    ...common,
    value: z.literal("attribute"),
    attribute: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    resolveUrl: z.boolean().optional(),
  }),
]);
export type Field =
  | z.infer<typeof leaf>
  | {
      selector: string;
      optional?: boolean;
      multiple?: boolean;
      fields: Fields;
    };
export type Fields = Record<string, Field>;
const field: z.ZodType<Field> = z.lazy(() =>
  z.union([leaf, z.strictObject({ ...common, fields: z.record(key, field) })]),
);
const fields = z
  .record(key, field)
  .refine((f) => Object.keys(f).length > 0, "At least one field is required");
const wait = z.strictObject({ selector });
export const specSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  list: z.strictObject({
    itemSelector: selector,
    waitFor: wait.optional(),
    fields,
  }),
  identityField: key.optional(),
  detail: z
    .strictObject({ linkField: key, waitFor: wait.optional(), fields })
    .optional(),
  pagination: z.strictObject({ type: z.literal("next"), selector }).optional(),
});
export type Spec = z.infer<typeof specSchema>;

// Bound recursion before passing untrusted input to a recursive validator.
export function parseSpec(
  input: unknown,
  validateSelector?: (selector: string) => void,
): Spec {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  if (!raw || new TextEncoder().encode(raw).length > LIMITS.specBytes)
    throw new Error("Specification exceeds 64 KB.");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 20) throw new Error("Specification is too deeply nested.");
    } else if (char === "}" || char === "]") depth--;
  }
  const spec = specSchema.parse(JSON.parse(raw));
  let count = 0;
  const checkSelector = (s: string) => {
    try {
      validateSelector?.(s);
    } catch {
      throw new Error(`Invalid CSS selector: ${s}`);
    }
  };
  const check = (fs: Fields, level: number) => {
    if (level > LIMITS.depth)
      throw new Error("Nested fields exceed maximum depth.");
    for (const f of Object.values(fs)) {
      if (++count > LIMITS.fields) throw new Error("Too many fields.");
      checkSelector(f.selector);
      if ("fields" in f) check(f.fields, level + 1);
    }
  };
  checkSelector(spec.list.itemSelector);
  check(spec.list.fields, 1);
  if (spec.list.waitFor) checkSelector(spec.list.waitFor.selector);
  if (spec.detail) {
    const link = spec.list.fields[spec.detail.linkField];
    if (
      !link ||
      "fields" in link ||
      link.value !== "attribute" ||
      link.attribute !== "href" ||
      !link.resolveUrl ||
      link.multiple
    )
      throw new Error(
        "detail.linkField must reference a single resolved href field.",
      );
    check(spec.detail.fields, 1);
    if (spec.detail.waitFor) checkSelector(spec.detail.waitFor.selector);
  }
  if (
    spec.identityField &&
    !Object.hasOwn(spec.list.fields, spec.identityField)
  )
    throw new Error("identityField must reference a listing field.");
  if (spec.pagination) checkSelector(spec.pagination.selector);
  return spec;
}

export function navigationUrl(
  value: string,
  base: string,
  origin: string,
): string {
  const url = new URL(value, base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    value.length > 8192
  )
    throw new Error("Navigation outside the approved origin is blocked.");
  url.hash = "";
  return url.href;
}
