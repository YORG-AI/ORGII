import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");
const componentsRoot = join(repoRoot, "src", "components");
const forbiddenTopLevelLayers = new Set([
  "engines",
  "features",
  "modules",
  "scaffold",
]);

// Existing mixed-ownership components are recorded explicitly so this guard
// prevents regression without pretending the remaining migration is complete.
// Remove an entry as soon as that component is moved or inverted.
const allowedLegacyViolations = new Set([
  "src/components/ComposerBar/index.tsx",
  "src/components/ErrorBoundary/index.tsx",
  "src/components/IssueHoverCard/index.tsx",
  "src/components/MarkDown/MarkDownImpl.tsx",
  "src/components/MarkDown/MermaidBlock.tsx",
  "src/components/ModelTable/ModelVariantInlineCard.tsx",
  "src/components/QuitConfirmationModal/index.tsx",
  "src/components/ResizableSplitPanel/index.tsx",
  "src/components/SessionHoverCard/SessionHoverCardContent.tsx",
  "src/components/SessionHoverCard/useSessionTurnOverview.ts",
  "src/components/ShellReplayOutput/index.tsx",
  "src/components/System/RepoLoader.tsx",
  "src/components/TerminalInteractive/terminalSetup.ts",
  "src/components/TerminalReadOnly/index.tsx",
  "src/components/TerminalReadOnly/outputBuffer.ts",
  "src/components/WorkItemHoverCard/index.tsx",
]);

function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(fullPath));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function importedTopLevelLayers(source) {
  const layers = new Set();
  const importPattern = /\b(?:from\s+|import\s*\(\s*)["']@src\/([^/"']+)/g;
  for (const match of source.matchAll(importPattern)) {
    if (forbiddenTopLevelLayers.has(match[1])) layers.add(match[1]);
  }
  return layers;
}

const currentViolations = new Map();
for (const file of listSourceFiles(componentsRoot)) {
  if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(file)) continue;
  const layers = importedTopLevelLayers(readFileSync(file, "utf8"));
  if (layers.size === 0) continue;
  currentViolations.set(relative(repoRoot, file), [...layers].sort());
}

const unexpected = [...currentViolations].filter(
  ([file]) => !allowedLegacyViolations.has(file)
);
const staleAllowlist = [...allowedLegacyViolations].filter(
  (file) => !currentViolations.has(file)
);

if (unexpected.length > 0 || staleAllowlist.length > 0) {
  if (unexpected.length > 0) {
    console.error("New src/components layer violations found:");
    for (const [file, layers] of unexpected) {
      console.error(`- ${file}: imports ${layers.join(", ")}`);
    }
  }
  if (staleAllowlist.length > 0) {
    console.error(
      "Resolved component violations still present in the allowlist:"
    );
    for (const file of staleAllowlist) console.error(`- ${file}`);
  }
  process.exit(1);
}

console.log(
  `Component boundary check passed (${currentViolations.size} tracked legacy violations, no new violations)`
);
