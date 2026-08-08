/**
 * useEnvScan
 *
 * Scans a repo directory for env template files (.env.example, .env.template,
 * .env.sample, .env.local, .env.development) and the actual .env file.
 * Parses both to determine which env vars are required and which are filled.
 *
 * Fallback: when no template exists, scans .env directly.
 * If .env has vars → status "ready". If neither template nor .env → "no_env_config".
 *
 * Also supports writing updated values back to .env via saveEnvValues().
 */
import { useCallback, useEffect, useState } from "react";

import type { EnvScanResult, EnvVar, SetupStatus } from "../types";
import { useFocusRegainedRescan } from "./useFocusRegainedRescan";

const TEMPLATE_FILES = [
  ".env.example",
  ".env.template",
  ".env.sample",
  ".env.local",
  ".env.development",
] as const;

const EMPTY_RESULT: EnvScanResult = {
  status: "not_analyzed",
  templateFile: null,
  vars: [],
  filledCount: 0,
  totalCount: 0,
};

/**
 * Parse a dotenv-format string into key/value pairs.
 * Handles comments, empty lines, quoted values, and inline comments.
 */
function parseDotenv(
  content: string
): Map<string, { value: string; comment?: string }> {
  const entries = new Map<string, { value: string; comment?: string }>();
  let pendingComment: string | undefined;

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) {
      if (line.startsWith("#")) {
        const text = line.slice(1).trim();
        if (text && !/^[=\-#*~_]{3,}$/.test(text)) {
          pendingComment = text;
        }
      }
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = line.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.set(key, { value, comment: pendingComment });
    pendingComment = undefined;
  }

  return entries;
}

async function scanEnvFiles(repoPath: string): Promise<EnvScanResult> {
  const { exists, readTextFile } = await import("@tauri-apps/plugin-fs");

  let templateFile: string | null = null;
  let templateContent = "";

  for (const name of TEMPLATE_FILES) {
    const fullPath = `${repoPath}/${name}`;
    if (await exists(fullPath)) {
      templateFile = name;
      templateContent = await readTextFile(fullPath);
      break;
    }
  }

  const envPath = `${repoPath}/.env`;
  const envExists = await exists(envPath);
  const envVars = envExists
    ? parseDotenv(await readTextFile(envPath))
    : new Map<string, { value: string; comment?: string }>();

  if (!templateFile) {
    if (envExists && envVars.size > 0) {
      const vars: EnvVar[] = [];
      for (const [key, entry] of envVars) {
        vars.push({
          key,
          value: entry.value,
          source: "env",
          filled: entry.value !== "",
          comment: entry.comment,
        });
      }
      const filledCount = vars.filter((v) => v.filled).length;
      const status: SetupStatus =
        filledCount === vars.length ? "ready" : "params_missing";
      return {
        status,
        templateFile: ".env",
        vars,
        filledCount,
        totalCount: vars.length,
      };
    }
    return {
      status: "no_env_config",
      templateFile: null,
      vars: [],
      filledCount: 0,
      totalCount: 0,
    };
  }

  const templateVars = parseDotenv(templateContent);

  const vars: EnvVar[] = [];
  let filledCount = 0;

  for (const [key, templateEntry] of templateVars) {
    const envEntry = envVars.get(key);
    const hasValue = envEntry !== undefined && envEntry.value !== "";
    if (hasValue) filledCount++;

    vars.push({
      key,
      value: envEntry?.value ?? templateEntry.value,
      source: hasValue ? "env" : "template",
      filled: hasValue,
      comment: templateEntry.comment,
    });
  }

  const totalCount = vars.length;
  const status: SetupStatus =
    totalCount === 0
      ? "no_env_config"
      : filledCount === totalCount
        ? "ready"
        : "params_missing";

  return { status, templateFile, vars, filledCount, totalCount };
}

/**
 * Serialize env vars back to .env file content.
 */
function serializeEnv(vars: EnvVar[]): string {
  return (
    vars
      .map((envVar) => {
        const prefix = envVar.comment ? `# ${envVar.comment}\n` : "";
        const needsQuote =
          envVar.value.includes(" ") || envVar.value.includes("#");
        const value = needsQuote ? `"${envVar.value}"` : envVar.value;
        return `${prefix}${envVar.key}=${value}`;
      })
      .join("\n") + "\n"
  );
}

interface EnvScanSnapshot {
  key: string;
  result: EnvScanResult;
}

export function useEnvScan(repoPath: string | undefined) {
  const [snapshot, setSnapshot] = useState<EnvScanSnapshot | null>(null);
  const [tick, setTick] = useState(0);

  const requestKey = `${repoPath ?? ""}:${tick}`;

  const refresh = useCallback(() => {
    setTick((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!repoPath) return;

    let cancelled = false;
    const key = `${repoPath}:${tick}`;

    scanEnvFiles(repoPath)
      .then((result) => {
        if (!cancelled) setSnapshot({ key, result });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ key, result: EMPTY_RESULT });
      });

    return () => {
      cancelled = true;
    };
  }, [repoPath, tick]);

  // Re-scan when the window regains focus (e.g. after agent session).
  // Flap-cooled.
  useFocusRegainedRescan(Boolean(repoPath), refresh);

  const validResult =
    snapshot?.key === requestKey ? snapshot.result : EMPTY_RESULT;
  const loading = repoPath ? snapshot?.key !== requestKey : false;

  const saveEnvValues = useCallback(
    async (updatedVars: EnvVar[]) => {
      if (!repoPath) return;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const content = serializeEnv(updatedVars);
      await writeTextFile(`${repoPath}/.env`, content);
      refresh();
    },
    [repoPath, refresh]
  );

  return { ...validResult, loading, refresh, saveEnvValues };
}
