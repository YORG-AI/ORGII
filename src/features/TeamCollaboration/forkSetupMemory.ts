import type { ForkSessionSetupSelection } from "./components/ForkSessionSetupDialog";

const STORAGE_KEY = "orgii:fork-setup-memory-v1";
const NO_REPO_KEY = "__no_repo__";

type ForkSetupMemory = Record<
  string,
  ForkSessionSetupSelection & { savedAt: string }
>;

function memoryKey(repoScopeKey: string | null | undefined): string {
  return repoScopeKey?.trim() || NO_REPO_KEY;
}

function readAll(): ForkSetupMemory {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ForkSetupMemory)
      : {};
  } catch {
    return {};
  }
}

function writeAll(memory: ForkSetupMemory): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Best-effort persistence; the setup dialog remains the fallback.
  }
  version += 1;
  for (const listener of [...listeners]) listener();
}

let version = 0;
const listeners = new Set<() => void>();

/** Re-render hook for surfaces that mirror the memory (composer model pill). */
export function subscribeForkSetupMemory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function forkSetupMemoryVersion(): number {
  return version;
}

/** Last confirmed continuation setup for this repo scope, if any. */
export function loadForkSetupMemory(
  repoScopeKey: string | null | undefined
): ForkSessionSetupSelection | null {
  const entry = readAll()[memoryKey(repoScopeKey)];
  if (!entry?.execution?.agentDefinitionId) return null;
  return {
    workspaceRepoPath: entry.workspaceRepoPath,
    execution: entry.execution,
  };
}

export function saveForkSetupMemory(
  repoScopeKey: string | null | undefined,
  selection: ForkSessionSetupSelection
): void {
  if (!selection.execution?.agentDefinitionId) return;
  const memory = readAll();
  memory[memoryKey(repoScopeKey)] = {
    ...selection,
    savedAt: new Date().toISOString(),
  };
  writeAll(memory);
}

export function clearForkSetupMemory(
  repoScopeKey: string | null | undefined
): void {
  const memory = readAll();
  delete memory[memoryKey(repoScopeKey)];
  writeAll(memory);
}
