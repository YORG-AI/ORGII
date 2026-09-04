/**
 * useAgentFileChangeListener
 *
 * Subscribes to the `agent-file-change` window event broadcast by the
 * session sync layer (`fileChangeHandlers.handleFileChange`) whenever an
 * agent's edit / create / delete tool touches files on disk.
 *
 * The event used to be dropped by the `dispatchAgentEvent` default branch,
 * which meant the file tree and git status only refreshed on the next poll
 * tick (or never). This hook lets any feature opt into an immediate refresh.
 *
 * Mirrors the shape of `useRepoStatusListener`: the callback is expected to
 * be stable (debounce it at the call site to coalesce bursts of edits from
 * a single multi-file tool call).
 */
import { useEffect } from "react";

import {
  AGENT_SIDE_CHANNEL_EVENTS,
  type AgentFileChangeDetail,
} from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/fileChangeHandlers";

/**
 * @param sessionId - Session to watch. When provided, only file-change
 *                    events for that session invoke `onChange`. Pass
 *                    `undefined` to receive events for every session.
 * @param onChange  - Stable callback invoked with the change detail.
 */
export function useAgentFileChangeListener(
  sessionId: string | undefined,
  onChange: (detail: AgentFileChangeDetail) => void
): void {
  useEffect(() => {
    let cancelled = false;

    const listener = (evt: Event): void => {
      if (cancelled) return;
      const detail = (evt as CustomEvent<AgentFileChangeDetail>).detail;
      if (!detail) return;
      if (sessionId && detail.sessionId !== sessionId) return;
      onChange(detail);
    };

    window.addEventListener(
      AGENT_SIDE_CHANNEL_EVENTS.FILE_CHANGE,
      listener as EventListener
    );

    return () => {
      cancelled = true;
      window.removeEventListener(
        AGENT_SIDE_CHANNEL_EVENTS.FILE_CHANGE,
        listener as EventListener
      );
    };
  }, [sessionId, onChange]);
}
