#!/usr/bin/env node

/**
 * Fails when the production boot bundle grows past config/bundle-budget.json.
 *
 * "Boot" is what the webview evaluates before first paint: the `main`
 * entrypoint chunks (runtime, vendors, main) plus the chunk group that
 * src/index.tsx loads with `import("@src/App")` — App and every async-vendor
 * chunk split out of it. Measured 2026-09-04: 37 chunks, 6.3 MB of JS, 2,790
 * src JS modules (47% of the tree), because the persistent shell statically
 * imports the chat engine, cloud sync, spotlight and sidebar connectors. Every
 * evaluated module's source text stays resident in JSC for the life of the
 * page, so this number is the frontend's memory floor.
 *
 * Usage:
 *   pnpm build:stats            # webpack production build + build/stats.json
 *   pnpm check:bundle-budget    # this script
 *   node scripts/quality/check-bundle-budget.mjs path/to/stats.json
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");

const budget = JSON.parse(
  readFileSync(join(ROOT, "config", "bundle-budget.json"), "utf8")
);
const statsPath = resolve(ROOT, process.argv[2] ?? budget.statsPath);

let stats;
try {
  stats = JSON.parse(readFileSync(statsPath, "utf8"));
} catch (error) {
  console.error(
    `check-bundle-budget: cannot read ${statsPath} (${error.message}). Run \`pnpm build:stats\` first.`
  );
  process.exit(2);
}

const entry = stats.entrypoints?.main;
if (!entry) {
  console.error("check-bundle-budget: stats has no `main` entrypoint.");
  process.exit(2);
}

/** Leaf modules, flattening webpack's concatenated-module groups. */
function* leafModules(modules) {
  for (const module of modules ?? []) {
    if (module.modules?.length) yield* leafModules(module.modules);
    else yield module;
  }
}

const bootIds = new Set(entry.chunks.map(String));
for (const chunk of stats.chunks) {
  const loadedByAppImport = (chunk.origins ?? []).some(
    (origin) =>
      origin.request === "@src/App" &&
      (origin.moduleName ?? "").includes("src/index.tsx")
  );
  if (loadedByAppImport) bootIds.add(String(chunk.id));
}

const assetSize = new Map(
  stats.assets.map((asset) => [asset.name, asset.size])
);
const bootChunks = stats.chunks.filter((chunk) =>
  bootIds.has(String(chunk.id))
);

let jsBytes = 0;
let cssBytes = 0;
for (const chunk of bootChunks) {
  for (const file of chunk.files ?? []) {
    const size = assetSize.get(file) ?? 0;
    if (file.endsWith(".js")) jsBytes += size;
    else if (file.endsWith(".css")) cssBytes += size;
  }
}

// Only JavaScript modules count toward the module budget: JSON and asset
// modules (`?url` icons resolve to a one-line URL stub) are not code the
// engine has to parse, so they must not be able to trip the gate.
const isJsModule = (module) =>
  (module.moduleType ?? "javascript/auto").startsWith("javascript");

const GROUPED_ROOTS = new Set([
  "modules",
  "features",
  "engines",
  "scaffold",
  "store",
  "components",
  "hooks",
  "api",
  "app",
]);
const srcModules = new Set();
const areaSizes = new Map();
for (const chunk of bootChunks) {
  for (const module of leafModules(chunk.modules)) {
    const name = module.name ?? "";
    if (!name.startsWith("./src/") || srcModules.has(name)) continue;
    if (!isJsModule(module)) continue;
    srcModules.add(name);
    const segments = name.split("/");
    const area = GROUPED_ROOTS.has(segments[2])
      ? segments.slice(2, 4).join("/")
      : segments[2];
    const current = areaSizes.get(area) ?? { modules: 0, bytes: 0 };
    current.modules += 1;
    current.bytes += module.size ?? 0;
    areaSizes.set(area, current);
  }
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const { maxJsBytes, maxSrcModules } = budget.boot;

console.log(`Boot bundle (${bootChunks.length} chunks)`);
console.log(
  `  JS          ${mb(jsBytes).padStart(9)}   budget ${mb(maxJsBytes)}`
);
console.log(`  CSS         ${mb(cssBytes).padStart(9)}`);
console.log(
  `  src JS mods ${String(srcModules.size).padStart(9)}   budget ${maxSrcModules}`
);
console.log("  Largest areas (src JS modules / unminified bytes):");
for (const [area, { modules, bytes }] of [...areaSizes.entries()]
  .sort((a, b) => b[1].modules - a[1].modules)
  .slice(0, 12)) {
  console.log(
    `    ${String(modules).padStart(5)}  ${mb(bytes).padStart(9)}  ${area}`
  );
}

const failures = [];
if (jsBytes > maxJsBytes) {
  failures.push(`boot JS ${mb(jsBytes)} exceeds budget ${mb(maxJsBytes)}`);
}
if (srcModules.size > maxSrcModules) {
  failures.push(
    `boot src JS modules ${srcModules.size} exceed budget ${maxSrcModules}`
  );
}

if (failures.length > 0) {
  console.error(
    `\ncheck-bundle-budget: FAILED\n  - ${failures.join("\n  - ")}`
  );
  console.error(
    "\nSomething new is statically reachable from the shell. Move it behind a\n" +
      "React.lazy island or a dynamic import(); if the growth is intended,\n" +
      "raise config/bundle-budget.json in this PR and say why."
  );
  process.exit(1);
}
console.log("\ncheck-bundle-budget: OK");
