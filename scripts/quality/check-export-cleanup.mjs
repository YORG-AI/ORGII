/**
 * Compare emitted static module loads against a cleanup's base revision.
 * This checks initialization order, not reachability or runtime performance.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const base = process.argv[2] ?? "origin/develop";
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const files = git("diff", "--name-only", "--diff-filter=M", base, "--", "src")
  .trim()
  .split("\n")
  .filter((file) => /\.tsx?$/.test(file));

function moduleLoads(file, source) {
  const emitted = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const parsed = ts.createSourceFile(
    `${file}.js`,
    emitted,
    ts.ScriptTarget.Latest,
    true
  );
  return [
    ...new Set(
      parsed.statements
        .filter(
          (node) =>
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier
        )
        .map((node) => node.moduleSpecifier.text)
    ),
  ];
}

let failures = 0;
for (const file of files) {
  let before = moduleLoads(file, git("show", `${base}:${file}`));
  const after = moduleLoads(file, readFileSync(file, "utf8"));
  // The glyph barrel deliberately drops individually imported, unused assets.
  if (file === "src/icons.ts") {
    before = before.filter(
      (source) =>
        !source.startsWith("@hugeicons/core-free-icons/") ||
        after.includes(source)
    );
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    failures++;
    console.error(`${file}: static module loading changed`, { before, after });
  }
}
console.log(
  `Checked ${files.length} source files; ${failures} module-load changes`
);
process.exitCode = failures ? 1 : 0;
