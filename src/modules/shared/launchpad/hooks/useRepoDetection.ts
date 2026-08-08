/**
 * useRepoDetection
 *
 * Detects repo type and config files by inspecting the repo directory
 * via @tauri-apps/plugin-fs.
 */
import { useCallback, useEffect, useState } from "react";

import type {
  DetectedConfigFile,
  RepoDetectionResult,
  RepoType,
} from "../types";
import { REPO_TYPES } from "../types";
import { useFocusRegainedRescan } from "./useFocusRegainedRescan";

const EMPTY_RESULT: RepoDetectionResult = {
  repoType: "unknown",
  repoTypeLabel: REPO_TYPES.unknown,
  configFiles: [],
  hasDocker: false,
  hasMakefile: false,
};

interface ConfigProbe {
  file: string;
  repoType: RepoType;
}

const CONFIG_PROBES: ConfigProbe[] = [
  { file: "package.json", repoType: "node" },
  { file: "Cargo.toml", repoType: "rust" },
  { file: "pyproject.toml", repoType: "python" },
  { file: "requirements.txt", repoType: "python" },
  { file: "go.mod", repoType: "go" },
  { file: "pom.xml", repoType: "java" },
  { file: "build.gradle", repoType: "kotlin" },
  { file: "build.gradle.kts", repoType: "kotlin" },
  { file: "Gemfile", repoType: "ruby" },
  { file: "composer.json", repoType: "php" },
  { file: "pubspec.yaml", repoType: "dart" },
  { file: "mix.exs", repoType: "elixir" },
  { file: "global.json", repoType: "csharp" },
];

const EXTRA_CONFIG_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Makefile",
  ".env",
  "tsconfig.json",
  ".eslintrc.json",
  ".prettierrc",
];

export async function detectRepo(
  repoPath: string
): Promise<RepoDetectionResult> {
  const { exists } = await import("@tauri-apps/plugin-fs");

  let repoType: RepoType = "unknown";
  const configFiles: DetectedConfigFile[] = [];
  let hasDocker = false;
  let hasMakefile = false;

  for (const probe of CONFIG_PROBES) {
    const fullPath = `${repoPath}/${probe.file}`;
    const found = await exists(fullPath);
    if (found) {
      if (repoType === "unknown") {
        repoType = probe.repoType;
      }
      configFiles.push({ name: probe.file, path: fullPath });
    }
  }

  for (const fileName of EXTRA_CONFIG_FILES) {
    const fullPath = `${repoPath}/${fileName}`;
    const found = await exists(fullPath);
    if (found) {
      configFiles.push({ name: fileName, path: fullPath });
      if (fileName === "Dockerfile" || fileName.startsWith("docker-compose")) {
        hasDocker = true;
      }
      if (fileName === "Makefile") {
        hasMakefile = true;
      }
    }
  }

  return {
    repoType,
    repoTypeLabel: REPO_TYPES[repoType],
    configFiles,
    hasDocker,
    hasMakefile,
  };
}

interface DetectionSnapshot {
  key: string;
  result: RepoDetectionResult;
}

export function useRepoDetection(repoPath: string | undefined) {
  const [snapshot, setSnapshot] = useState<DetectionSnapshot | null>(null);
  const [tick, setTick] = useState(0);

  const requestKey = `${repoPath ?? ""}:${tick}`;

  const refresh = useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!repoPath) return;

    let cancelled = false;
    const key = `${repoPath}:${tick}`;

    detectRepo(repoPath)
      .then((detection) => {
        if (!cancelled) setSnapshot({ key, result: detection });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ key, result: EMPTY_RESULT });
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, tick]);

  // Re-detect when the window regains focus (e.g. after an agent session
  // adds new config files to the repo). Flap-cooled.
  useFocusRegainedRescan(Boolean(repoPath), refresh);

  const validResult =
    snapshot?.key === requestKey ? snapshot.result : EMPTY_RESULT;
  const loading = repoPath ? snapshot?.key !== requestKey : false;

  return { ...validResult, loading, refresh };
}
