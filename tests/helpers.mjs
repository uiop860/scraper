import { build } from "esbuild";
export async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  return `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;
}
export const protocol = await import(
  await bundle("extension/auth/protocol.ts")
);
