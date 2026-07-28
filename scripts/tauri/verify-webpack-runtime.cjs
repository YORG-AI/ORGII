#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function verifyWebpackRuntimeGuards(buildDir) {
  const files = fs
    .readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name);
  const runtimeFiles = files.filter((name) => /^runtime\..+\.js$/.test(name));
  if (runtimeFiles.length !== 1) {
    throw new Error(
      `Expected exactly one webpack runtime asset, found ${runtimeFiles.length}`
    );
  }

  const runtimeText = fs.readFileSync(
    path.join(buildDir, runtimeFiles[0]),
    "utf8"
  );
  const runtimeMatch = runtimeText.match(/\.j=(\d+)(?:[,;}])/);
  if (!runtimeMatch) {
    throw new Error(`Could not read runtime id from ${runtimeFiles[0]}`);
  }

  const runtimeId = runtimeMatch[1];
  const allowedIds = new Set(["0", runtimeId]);
  // Named chunks (for example `orgii-chat-projection.<hash>.js`) keep their
  // numeric id only in the runtime filename maps, so include every emitted
  // map key as a legitimate guard target.
  for (const match of runtimeText.matchAll(/(?:^|[,{])(\d+):/g)) {
    allowedIds.add(match[1]);
  }
  for (const name of files) {
    const chunkMatch = name.match(/^(\d+)\..+\.js$/);
    if (chunkMatch) allowedIds.add(chunkMatch[1]);
  }

  const staleGuards = new Map();
  for (const name of files) {
    const source = fs.readFileSync(path.join(buildDir, name), "utf8");
    for (const match of source.matchAll(/\.j={2,3}(\d+)/g)) {
      const guardId = match[1];
      if (allowedIds.has(guardId)) continue;
      const assets = staleGuards.get(guardId) ?? [];
      assets.push(name);
      staleGuards.set(guardId, assets);
    }
  }

  if (staleGuards.size > 0) {
    const detail = [...staleGuards.entries()]
      .map(([id, assets]) => `${id} in ${[...new Set(assets)].join(", ")}`)
      .join("; ");
    throw new Error(
      `Webpack emitted stale runtime guard(s); runtime=${runtimeId}: ${detail}`
    );
  }

  return { runtimeId, assetsChecked: files.length };
}

if (require.main === module) {
  const buildDir = path.resolve(process.argv[2] ?? path.join("build"));
  const result = verifyWebpackRuntimeGuards(buildDir);
  console.log(
    `[verify-webpack-runtime] runtime=${result.runtimeId}, assets=${result.assetsChecked}`
  );
}

module.exports = { verifyWebpackRuntimeGuards };
