/**
 * useScriptDiscovery
 *
 * Discovers runnable scripts from a repo by reading:
 * - package.json "scripts" (Node.js)
 * - Makefile targets (Make)
 * - Cargo.toml binary/workspace targets (Rust)
 * - pyproject.toml [project.scripts] (Python)
 *
 * Returns a categorized list of RepoScript entries the user can launch.
 */
import { useCallback, useEffect, useState } from "react";

import type { RepoScript, RepoType, ScriptCategory } from "../types";
import { useFocusRegainedRescan } from "./useFocusRegainedRescan";

// ============================================
// Category inference from script name
// ============================================

const CATEGORY_PATTERNS: [RegExp, ScriptCategory][] = [
  [/^(dev|serve|watch|start:dev)$/i, "dev"],
  [/^(start|run|up|launch)$/i, "start"],
  [/^(build|compile|dist|bundle|release)$/i, "build"],
  [/^(test|spec|e2e|coverage|check)$/i, "test"],
  [/^(lint|format|fmt|eslint|prettier|clippy)$/i, "lint"],
];

function inferCategory(name: string): ScriptCategory {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(name)) return category;
  }
  if (name.includes("dev") || name.includes("watch")) return "dev";
  if (name.includes("build") || name.includes("compile")) return "build";
  if (name.includes("test") || name.includes("spec")) return "test";
  if (name.includes("lint") || name.includes("fmt")) return "lint";
  return "other";
}

// ============================================
// Parsers per project type
// ============================================

async function parseNodeScripts(repoPath: string): Promise<RepoScript[]> {
  const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
  const pkgPath = `${repoPath}/package.json`;
  if (!(await exists(pkgPath))) return [];

  try {
    const raw = await readTextFile(pkgPath);
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (!scripts || typeof scripts !== "object") return [];

    const pm = await detectPackageManager(repoPath);

    return Object.entries(scripts).map(([name, _cmd]) => ({
      name,
      command: `${pm} run ${name}`,
      category: inferCategory(name),
      source: "package.json" as const,
    }));
  } catch {
    return [];
  }
}

async function detectPackageManager(repoPath: string): Promise<string> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  if (await exists(`${repoPath}/pnpm-lock.yaml`)) return "pnpm";
  if (await exists(`${repoPath}/yarn.lock`)) return "yarn";
  if (await exists(`${repoPath}/bun.lockb`)) return "bun";
  return "npm";
}

async function parseMakefileTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
  const makePath = `${repoPath}/Makefile`;
  if (!(await exists(makePath))) return [];

  try {
    const content = await readTextFile(makePath);
    const scripts: RepoScript[] = [];
    const targetRegex = /^([a-zA-Z_][\w-]*):/gm;
    let match: RegExpExecArray | null;

    while ((match = targetRegex.exec(content)) !== null) {
      const name = match[1];
      if (name.startsWith("_") || name.startsWith(".")) continue;
      scripts.push({
        name,
        command: `make ${name}`,
        category: inferCategory(name),
        source: "Makefile",
      });
    }
    return scripts;
  } catch {
    return [];
  }
}

async function parseCargoTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const cargoPath = `${repoPath}/Cargo.toml`;
  if (!(await exists(cargoPath))) return [];

  return [
    {
      name: "run",
      command: "cargo run",
      category: "start",
      source: "Cargo.toml",
    },
    {
      name: "build",
      command: "cargo build",
      category: "build",
      source: "Cargo.toml",
    },
    {
      name: "build --release",
      command: "cargo build --release",
      category: "build",
      source: "Cargo.toml",
    },
    {
      name: "test",
      command: "cargo test",
      category: "test",
      source: "Cargo.toml",
    },
    {
      name: "clippy",
      command: "cargo clippy",
      category: "lint",
      source: "Cargo.toml",
    },
  ];
}

async function parsePythonScripts(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const scripts: RepoScript[] = [];

  if (await exists(`${repoPath}/pyproject.toml`)) {
    scripts.push({
      name: "install",
      command: "pip install -e .",
      category: "build",
      source: "pyproject.toml",
    });
  }

  if (await exists(`${repoPath}/manage.py`)) {
    scripts.push(
      {
        name: "runserver",
        command: "python manage.py runserver",
        category: "dev",
        source: "pyproject.toml",
      },
      {
        name: "test",
        command: "python manage.py test",
        category: "test",
        source: "pyproject.toml",
      }
    );
  }

  if (await exists(`${repoPath}/requirements.txt`)) {
    scripts.push({
      name: "install deps",
      command: "pip install -r requirements.txt",
      category: "build",
      source: "pyproject.toml",
    });
  }

  return scripts;
}

async function parseGoTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(`${repoPath}/go.mod`))) return [];

  return [
    { name: "run", command: "go run .", category: "start", source: "go" },
    {
      name: "build",
      command: "go build ./...",
      category: "build",
      source: "go",
    },
    { name: "test", command: "go test ./...", category: "test", source: "go" },
    { name: "vet", command: "go vet ./...", category: "lint", source: "go" },
  ];
}

async function parseJavaTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const scripts: RepoScript[] = [];

  if (await exists(`${repoPath}/pom.xml`)) {
    scripts.push(
      {
        name: "install",
        command: "mvn install",
        category: "build",
        source: "pom.xml",
      },
      {
        name: "test",
        command: "mvn test",
        category: "test",
        source: "pom.xml",
      },
      {
        name: "package",
        command: "mvn package",
        category: "build",
        source: "pom.xml",
      },
      {
        name: "clean",
        command: "mvn clean",
        category: "build",
        source: "pom.xml",
      }
    );
  }

  return scripts;
}

async function parseGradleTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  const scripts: RepoScript[] = [];
  const hasKts = await exists(`${repoPath}/build.gradle.kts`);
  const hasGroovy = await exists(`${repoPath}/build.gradle`);

  if (!hasKts && !hasGroovy) return [];
  const source = hasKts ? "build.gradle.kts" : "build.gradle";

  scripts.push(
    { name: "build", command: "./gradlew build", category: "build", source },
    { name: "test", command: "./gradlew test", category: "test", source },
    { name: "run", command: "./gradlew run", category: "start", source },
    { name: "clean", command: "./gradlew clean", category: "build", source }
  );
  return scripts;
}

async function parseRubyTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(`${repoPath}/Gemfile`))) return [];

  const scripts: RepoScript[] = [
    {
      name: "bundle install",
      command: "bundle install",
      category: "build",
      source: "Gemfile",
    },
  ];
  if (await exists(`${repoPath}/Rakefile`)) {
    scripts.push({
      name: "rake",
      command: "bundle exec rake",
      category: "start",
      source: "Gemfile",
    });
  }
  if (await exists(`${repoPath}/config.ru`)) {
    scripts.push({
      name: "server",
      command: "bundle exec rails server",
      category: "dev",
      source: "Gemfile",
    });
    scripts.push({
      name: "test",
      command: "bundle exec rails test",
      category: "test",
      source: "Gemfile",
    });
  }
  return scripts;
}

async function parsePhpTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(`${repoPath}/composer.json`))) return [];

  const scripts: RepoScript[] = [
    {
      name: "install",
      command: "composer install",
      category: "build",
      source: "composer.json",
    },
  ];

  try {
    const raw = await readTextFile(`${repoPath}/composer.json`);
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const composerScripts = pkg.scripts as Record<string, unknown> | undefined;
    if (composerScripts && typeof composerScripts === "object") {
      for (const name of Object.keys(composerScripts)) {
        scripts.push({
          name,
          command: `composer run ${name}`,
          category: inferCategory(name),
          source: "composer.json",
        });
      }
    }
  } catch {
    // ignore parse failures
  }
  return scripts;
}

async function parseDartTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(`${repoPath}/pubspec.yaml`))) return [];

  return [
    {
      name: "get",
      command: "flutter pub get",
      category: "build",
      source: "pubspec.yaml",
    },
    {
      name: "run",
      command: "flutter run",
      category: "start",
      source: "pubspec.yaml",
    },
    {
      name: "build",
      command: "flutter build",
      category: "build",
      source: "pubspec.yaml",
    },
    {
      name: "test",
      command: "flutter test",
      category: "test",
      source: "pubspec.yaml",
    },
    {
      name: "analyze",
      command: "flutter analyze",
      category: "lint",
      source: "pubspec.yaml",
    },
  ];
}

async function parseElixirTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(`${repoPath}/mix.exs`))) return [];

  return [
    {
      name: "deps.get",
      command: "mix deps.get",
      category: "build",
      source: "mix.exs",
    },
    {
      name: "compile",
      command: "mix compile",
      category: "build",
      source: "mix.exs",
    },
    { name: "test", command: "mix test", category: "test", source: "mix.exs" },
    { name: "run", command: "mix run", category: "start", source: "mix.exs" },
    {
      name: "format",
      command: "mix format --check-formatted",
      category: "lint",
      source: "mix.exs",
    },
  ];
}

async function parseDotNetTargets(repoPath: string): Promise<RepoScript[]> {
  const { exists, readDir } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(`${repoPath}/global.json`))) return [];

  const scripts: RepoScript[] = [
    {
      name: "restore",
      command: "dotnet restore",
      category: "build",
      source: "global.json",
    },
    {
      name: "build",
      command: "dotnet build",
      category: "build",
      source: "global.json",
    },
    {
      name: "test",
      command: "dotnet test",
      category: "test",
      source: "global.json",
    },
    {
      name: "run",
      command: "dotnet run",
      category: "start",
      source: "global.json",
    },
  ];

  try {
    const entries = await readDir(repoPath);
    const hasSln = entries.some(
      (entry) => entry.name?.endsWith(".sln") ?? false
    );
    if (hasSln) {
      scripts[0].command = "dotnet restore *.sln";
      scripts[1].command = "dotnet build *.sln";
    }
  } catch {
    // ignore readDir failures
  }

  return scripts;
}

// ============================================
// Main discovery
// ============================================

const CATEGORY_ORDER: ScriptCategory[] = [
  "dev",
  "start",
  "build",
  "test",
  "lint",
  "other",
];

async function discoverScripts(
  repoPath: string,
  repoType: RepoType
): Promise<RepoScript[]> {
  const all: RepoScript[] = [];

  switch (repoType) {
    case "node":
      all.push(...(await parseNodeScripts(repoPath)));
      break;
    case "rust":
      all.push(...(await parseCargoTargets(repoPath)));
      break;
    case "python":
      all.push(...(await parsePythonScripts(repoPath)));
      break;
    case "go":
      all.push(...(await parseGoTargets(repoPath)));
      break;
    case "java":
      all.push(...(await parseJavaTargets(repoPath)));
      break;
    case "kotlin":
      all.push(...(await parseGradleTargets(repoPath)));
      break;
    case "ruby":
      all.push(...(await parseRubyTargets(repoPath)));
      break;
    case "php":
      all.push(...(await parsePhpTargets(repoPath)));
      break;
    case "dart":
      all.push(...(await parseDartTargets(repoPath)));
      break;
    case "elixir":
      all.push(...(await parseElixirTargets(repoPath)));
      break;
    case "csharp":
      all.push(...(await parseDotNetTargets(repoPath)));
      break;
    default:
      all.push(...(await parseNodeScripts(repoPath)));
      all.push(...(await parsePythonScripts(repoPath)));
      all.push(...(await parseCargoTargets(repoPath)));
      all.push(...(await parseGoTargets(repoPath)));
  }

  all.push(...(await parseMakefileTargets(repoPath)));

  const seen = new Set<string>();
  const deduped = all.filter((script) => {
    if (seen.has(script.command)) return false;
    seen.add(script.command);
    return true;
  });

  deduped.sort((scriptA, scriptB) => {
    const orderA = CATEGORY_ORDER.indexOf(scriptA.category);
    const orderB = CATEGORY_ORDER.indexOf(scriptB.category);
    if (orderA !== orderB) return orderA - orderB;
    return scriptA.name.localeCompare(scriptB.name);
  });

  return deduped;
}

// ============================================
// Hook
// ============================================

interface ScriptDiscoverySnapshot {
  key: string;
  scripts: RepoScript[];
}

export function useScriptDiscovery(
  repoPath: string | undefined,
  repoType: RepoType
) {
  const [snapshot, setSnapshot] = useState<ScriptDiscoverySnapshot | null>(
    null
  );
  const [tick, setTick] = useState(0);

  const requestKey = `${repoPath ?? ""}:${repoType}:${tick}`;

  const refresh = useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!repoPath) return;

    let cancelled = false;
    const key = `${repoPath}:${repoType}:${tick}`;

    discoverScripts(repoPath, repoType)
      .then((scripts) => {
        if (!cancelled) setSnapshot({ key, scripts });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ key, scripts: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, repoType, tick]);

  // Re-discover when the window regains focus (e.g. after an agent session
  // writes new scripts or package.json entries to the repo). Flap-cooled.
  useFocusRegainedRescan(Boolean(repoPath), refresh);

  const scripts = snapshot?.key === requestKey ? snapshot.scripts : [];
  const loading = repoPath ? snapshot?.key !== requestKey : false;

  return { scripts, loading, refresh };
}
