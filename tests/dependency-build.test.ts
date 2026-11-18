import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assert, test } from "vitest";
import { build } from "esbuild";
import { extensionDependencyCode } from "../scripts/extension-dependencies.ts";

test("both React builds lose only the two raw HTML assignment paths", async () => {
  for (const mode of ["production", "development"]) {
    const path = resolve(
      `node_modules/react-dom/cjs/react-dom-client.${mode}.js`,
    );
    const code = extensionDependencyCode(await readFile(path, "utf8"), path)!;
    assert.strictEqual(
      (code.match(/Raw HTML rendering is disabled/g) ?? []).length,
      2,
    );
    assert.ok(!code.includes("domElement.innerHTML = key"));
    // React's fixed script creation markup is separate from user-controlled HTML.
    assert.ok(code.includes('nextResource.innerHTML = "<script>'));
  }
});

test("restricted Zod validates and produces JSON schema without dynamic code", async () => {
  const result = await build({
    stdin: {
      contents: `import { z } from "zod"; const schema = z.strictObject({ title: z.string().min(1), price: z.number().positive() }); export const good = schema.safeParse({ title: "Desk", price: 500 }); export const bad = schema.safeParse({ title: "", price: -1 }); export const json = z.toJSONSchema(schema);`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "extension-dependencies",
        setup(build) {
          build.onLoad(
            { filter: /node_modules\/zod\/.*\.js$/ },
            async ({ path }) => {
              const source = await readFile(path, "utf8");
              return {
                contents: extensionDependencyCode(source, path) ?? source,
                loader: "js",
              };
            },
          );
        },
      },
    ],
  });
  const code = result.outputFiles[0]!.text;
  assert.ok(
    !/\bnew Function\s*\(|\b(?:const|let|var) F = Function\s*[;,]/.test(code),
  );
  const output = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  assert.strictEqual(output.good.success, true);
  assert.strictEqual(output.bad.success, false);
  assert.strictEqual(output.json.properties.title.type, "string");
});

test("dependency changes fail closed instead of silently losing restrictions", () => {
  assert.throws(
    () =>
      extensionDependencyCode(
        "changed upstream implementation",
        "/node_modules/zod/v4/core/util.js",
      ),
    /expected 1 matches, found 0/,
  );
  assert.strictEqual(
    extensionDependencyCode("unchanged", "/extension/example.ts"),
    null,
  );
});
