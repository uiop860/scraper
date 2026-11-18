// These pinned dependencies ship optional features the extension must not use.
// Remove their implementation before bundling, rather than suppressing AMO warnings.
// Fail closed when an upstream update changes the code we expect to replace.
function replaceExpected(
  code: string,
  pattern: RegExp,
  replacement: string,
  count: number,
  id: string,
) {
  const matches = [...code.matchAll(pattern)];
  if (matches.length !== count)
    throw new Error(
      `Review the extension dependency restrictions for ${id}: expected ${count} matches, found ${matches.length}.`,
    );
  return code.replace(pattern, replacement);
}

export function extensionDependencyCode(
  code: string,
  id: string,
): string | null {
  const path = id.split("?")[0]!.replaceAll("\\", "/");
  if (path.endsWith("/node_modules/zod/v4/core/util.js"))
    return replaceExpected(
      code,
      /export const allowsEval = [\s\S]*?\n\}\);/g,
      "export const allowsEval = { value: false };",
      1,
      id,
    );
  if (path.endsWith("/node_modules/zod/v4/core/doc.js"))
    return replaceExpected(
      code,
      / {4}compile\(\) \{[\s\S]*?\n {4}\}/g,
      '    compile() { throw new Error("Dynamic schema compilation is disabled in this extension."); }',
      1,
      id,
    );
  if (path.endsWith("/node_modules/zod/v4/core/compile.js"))
    return replaceExpected(
      code,
      /export function compileFn\(schema, options\) \{[\s\S]*?\n\}/g,
      'export function compileFn() { throw new ZodCompileUnsupportedError("dynamic compilation in this extension"); }',
      1,
      id,
    );
  if (
    /\/node_modules\/react-dom\/cjs\/react-dom-client\.(production|development)\.js$/.test(
      path,
    )
  )
    return replaceExpected(
      code,
      /case "dangerouslySetInnerHTML":\s+if \(null != value\) \{[\s\S]*?(?=\n\s*case )/g,
      'case "dangerouslySetInnerHTML":\n      if (value != null) throw new Error("Raw HTML rendering is disabled in this extension. Render text or React elements instead.");\n      break;',
      2,
      id,
    );
  return null;
}

export function extensionDependencies() {
  return {
    name: "extension-dependency-restrictions",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const restricted = extensionDependencyCode(code, id);
      return restricted === null ? null : { code: restricted, map: null };
    },
  };
}
