import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  minify: false,
};

if (watch) {
  const ctx = await esbuild.context(extensionConfig);
  await ctx.watch();
  console.log("[watch] build started");
} else {
  await esbuild.build(extensionConfig);
  console.log("build complete");
}
