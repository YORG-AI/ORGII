/**
 * usePublishWorkstationTabHeader
 *
 * Pane-side helper for the global 40px tab-header strip rendered by
 * {@link WorkstationTabHeader}. The active My Station pane (Code / Browser /
 * Database / Project) calls this hook with its own header content (e.g. a
 * file breadcrumb, a URL bar, a commit-info panel); the strip reads the
 * matching host slot via {@link activeWorkstationTabHeaderAtom} and renders
 * it on the right side of the global header.
 *
 * Cleanup semantics: on unmount the slot is cleared only if we are still
 * the current owner. This handles split-pane scenarios where pane A
 * unmounts after pane B has already published, in which case A's stale
 * cleanup must not blank B's header.
 *
 * Pass `enabled = false` when the pane isn't focused to suppress
 * publication entirely (e.g. for inactive split panes).
 */
import { useSetAtom } from "jotai";
import { useLayoutEffect, useMemo, useRef } from "react";

import {
  type WorkstationTabHeaderContribution,
  type WorkstationTabHeaderSlots,
  normalizeWorkstationTabHeaderContribution,
  workstationTabHeaderAtomByHost,
} from "@src/store/workstation";

type WorkstationTabHeaderHost = keyof typeof workstationTabHeaderAtomByHost;

interface UsePublishWorkstationTabHeaderOptions {
  host: WorkstationTabHeaderHost;
  content: WorkstationTabHeaderContribution;
  enabled?: boolean;
}

export function usePublishWorkstationTabHeader({
  host,
  content,
  enabled = true,
}: UsePublishWorkstationTabHeaderOptions): void {
  const setHeader = useSetAtom(workstationTabHeaderAtomByHost[host]);
  const normalizedContent = useMemo(
    () => normalizeWorkstationTabHeaderContribution(content),
    [content]
  );
  const ownedContentRef = useRef<WorkstationTabHeaderSlots | null>(null);

  useLayoutEffect(() => {
    if (!enabled) {
      setHeader((prev) => (prev === ownedContentRef.current ? null : prev));
      ownedContentRef.current = null;
      return;
    }

    ownedContentRef.current = normalizedContent;
    setHeader(normalizedContent);
  }, [enabled, normalizedContent, setHeader]);

  useLayoutEffect(() => {
    return () => {
      setHeader((prev) => (prev === ownedContentRef.current ? null : prev));
      ownedContentRef.current = null;
    };
  }, [setHeader]);
}

export type { WorkstationTabHeaderHost };
