/**
 * Debounced advertised-URL ingest from terminal PTY output.
 * Triggers a full OS rescan only when a new origin is accepted.
 */
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import type { WorkspacePortProbe } from "@src/api/tauri/workspacePorts";
import type { TerminalSession } from "@src/engines/TerminalCore/types";
import { createLogger } from "@src/hooks/logger";
import { activeFolderIdAtom } from "@src/store/ui/workspaceFoldersAtom";
import { terminalSessionsAtom } from "@src/store/workstation/codeEditor/terminal";
import {
  WORKSPACE_PORT_ADVERTISED_URL_DEBOUNCE_MS,
  workspacePortProbesAtom,
} from "@src/store/workstation/codeEditor/workspacePortsAtom";
import { safeUnlisten } from "@src/util/platform/tauri";
import { listenTauri } from "@src/util/platform/tauri/init";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";
import { normalizeHttpUrlCandidate } from "@src/util/url/validation";

import { ingestAdvertisedUrlAndMaybeRefresh } from "./workspacePortActions";

const logger = createLogger("WorkspacePortAdvertisedUrls");

const URL_CANDIDATE_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const PER_SESSION_BUFFER_LIMIT = 4096;

interface PtyOutputPayload {
  bytes?: number[];
  data?: string;
}

function extractOrigins(text: string): string[] {
  const origins: string[] = [];
  const matches = text.match(URL_CANDIDATE_PATTERN) ?? [];
  for (const match of matches) {
    const normalized = normalizeHttpUrlCandidate(match, {
      stripTextBoundaries: true,
    });
    if (!normalized) {
      continue;
    }
    try {
      const parsed = new URL(normalized);
      origins.push(parsed.origin);
    } catch {
      // Ignore invalid candidates.
    }
  }
  return origins;
}

function normalizeComparablePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return navigator.platform.toLowerCase().startsWith("win")
    ? normalized.toLowerCase()
    : normalized;
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function folderIdForPath(
  path: string | undefined,
  folders: WorkspacePortProbe[],
): string | null {
  if (!path) {
    return null;
  }
  const normalizedPath = normalizeComparablePath(path);
  let best: WorkspacePortProbe | null = null;
  for (const folder of folders) {
    const normalizedFolder = normalizeComparablePath(folder.path);
    if (!isSameOrDescendant(normalizedPath, normalizedFolder)) {
      continue;
    }
    if (
      !best ||
      normalizedFolder.length > normalizeComparablePath(best.path).length
    ) {
      best = folder;
    }
  }
  return best?.id ?? null;
}

function folderIdForTerminalSession(
  session: TerminalSession,
  folders: WorkspacePortProbe[],
  fallbackFolderId: string | null,
): string | null {
  return (
    folderIdForPath(session.liveCwd ?? session.cwd, folders) ?? fallbackFolderId
  );
}

export function useWorkspacePortAdvertisedUrls(enabled: boolean): void {
  const sessions = useAtomValue(terminalSessionsAtom);
  const folders = useAtomValue(workspacePortProbesAtom);
  const activeFolderId = useAtomValue(activeFolderIdAtom);
  const foldersRef = useRef(folders);
  const folderIdRef = useRef(activeFolderId);
  const pendingOriginsRef = useRef<Map<string, Set<string>>>(new Map());
  const debounceTimerRef = useRef<number | null>(null);

  useEffect(() => {
    foldersRef.current = folders;
    folderIdRef.current = activeFolderId;
  }, [activeFolderId, folders]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (foldersRef.current.length === 0) {
      return;
    }

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const buffers = new Map<string, string>();
    const pendingOriginsByFolder = pendingOriginsRef.current;
    const decoder = new TextDecoder("utf-8", { fatal: false });

    const flushPending = () => {
      debounceTimerRef.current = null;
      const entries = Array.from(pendingOriginsByFolder.entries()).map(
        ([folderId, origins]) => [folderId, Array.from(origins)] as const,
      );
      pendingOriginsByFolder.clear();
      if (entries.length === 0) {
        return;
      }
      for (const [folderId, origins] of entries) {
        for (const origin of origins) {
          void ingestAdvertisedUrlAndMaybeRefresh({
            folderId,
            origin,
            folders: foldersRef.current,
          }).catch((error: unknown) => {
            logger.warn("advertised URL ingest failed:", error);
          });
        }
      }
    };

    const queueOrigins = (folderId: string | null, origins: string[]) => {
      if (!folderId) {
        return;
      }
      if (origins.length === 0) {
        return;
      }
      const pendingForFolder =
        pendingOriginsByFolder.get(folderId) ?? new Set<string>();
      for (const origin of origins) {
        pendingForFolder.add(origin);
      }
      pendingOriginsByFolder.set(folderId, pendingForFolder);
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(
        flushPending,
        WORKSPACE_PORT_ADVERTISED_URL_DEBOUNCE_MS,
      );
    };

    const ingestChunk = (
      sessionId: string,
      folderId: string | null,
      chunk: string,
    ) => {
      const previous = buffers.get(sessionId) ?? "";
      let next = previous + chunk;
      if (next.length > PER_SESSION_BUFFER_LIMIT) {
        next = next.slice(-PER_SESSION_BUFFER_LIMIT);
      }
      const lastBreak = Math.max(
        next.lastIndexOf("\n"),
        next.lastIndexOf("\r"),
      );
      if (lastBreak === -1) {
        buffers.set(sessionId, next);
        return;
      }
      const finalized = next.slice(0, lastBreak + 1);
      buffers.set(sessionId, next.slice(lastBreak + 1));
      queueOrigins(folderId, extractOrigins(finalized));
    };

    void (async () => {
      for (const session of sessions) {
        if (cancelled) {
          return;
        }
        const backendSessionId = toBackendPtySessionId(session.id);
        try {
          const unlisten = await listenTauri<PtyOutputPayload>(
            `pty-output-${backendSessionId}`,
            (event) => {
              const fallbackFolderId =
                folderIdRef.current ?? foldersRef.current[0]?.id ?? null;
              const folderId = folderIdForTerminalSession(
                session,
                foldersRef.current,
                fallbackFolderId,
              );
              const { bytes, data } = event.payload;
              if (bytes && bytes.length > 0) {
                const decoded = decoder.decode(new Uint8Array(bytes), {
                  stream: true,
                });
                if (decoded) {
                  ingestChunk(backendSessionId, folderId, decoded);
                }
                return;
              }
              if (data) {
                ingestChunk(backendSessionId, folderId, data);
              }
            },
          );
          if (cancelled) {
            safeUnlisten(unlisten);
            return;
          }
          unlisteners.push(() => safeUnlisten(unlisten));
        } catch (error) {
          logger.warn("failed to listen for pty output:", error);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingOriginsByFolder.clear();
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [enabled, sessions]);
}
