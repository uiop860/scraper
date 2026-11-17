import { build } from "esbuild";
export async function bundle(entry: string) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  return `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.contents).toString("base64")}`;
}
