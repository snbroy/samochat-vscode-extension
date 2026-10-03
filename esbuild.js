const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const extensionContext = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
  });
  const webviewContext = await esbuild.context({
    entryPoints: ["media/main.js"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: false,
    platform: "browser",
    target: "es2020",
    outfile: "media/main.bundle.js",
    logLevel: "info",
  });

  if (watch) {
    await Promise.all([extensionContext.watch(), webviewContext.watch()]);
  } else {
    await Promise.all([extensionContext.rebuild(), webviewContext.rebuild()]);
    await Promise.all([extensionContext.dispose(), webviewContext.dispose()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
