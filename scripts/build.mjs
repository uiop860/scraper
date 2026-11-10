import { cp, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { watch } from "chokidar";

async function compile() {
  // Keep the last good build if TypeScript has a syntax error.
  const result = await build({
    entryPoints: [
      "extension/content.ts",
      "extension/background.ts",
      "extension/settings.ts",
      "extension/scraper.ts",
      "extension/callback.ts",
    ],
    outdir: "build",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "firefox142",
    write: false,
    logLevel: "info",
  });
  await rm("build", { recursive: true, force: true });
  await cp("extension", "build", {
    recursive: true,
    filter: (source) => !source.endsWith(".ts"),
  });
  for (const file of result.outputFiles) {
    await writeFile(file.path, file.contents);
  }
  console.log("Extension compiled into build/");
}

if (process.argv.includes("--watch")) {
  let queue = Promise.resolve();
  let timer;
  const watcher = watch(["extension", "tsconfig.json"], {
    ignoreInitial: true,
  });
  watcher.on("all", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      queue = queue.then(compile).catch((error) => console.error(error));
    }, 100);
  });
  watcher.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  await compile();
} else {
  await compile();
}
