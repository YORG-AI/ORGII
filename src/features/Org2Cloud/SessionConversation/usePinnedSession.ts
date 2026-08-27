import { useAtomValue } from "jotai";
import { useState } from "react";

import type { Session } from "@src/store/session";
import { sessionByIdAtom } from "@src/store/session";

interface PinnedSessionState {
  id: string;
  session: Session;
}

/**
 * `sessionByIdAtom` resident-row lookup with a per-view pin: sidebar roster
 * refreshes replace the sessions store wholesale, so a row opened from a
 * non-roster source (imported replay copy, external-history page beyond the
 * loaded window) can vanish from the atom seconds after opening. Identity
 * metadata (importedFrom, forkedFrom, org tags) must not flicker away with
 * it — the conversation surface keys its comments target and family anchor
 * on those fields. The pin holds the last resident row for the SAME session
 * id and releases as soon as the view moves to another session.
 */
export function usePinnedSession(sessionId: string): Session | undefined {
  const live = useAtomValue(sessionByIdAtom(sessionId)) as Session | undefined;
  const [pinned, setPinned] = useState<PinnedSessionState | null>(null);

  if (live && (pinned?.session !== live || pinned.id !== sessionId)) {
    setPinned({ id: sessionId, session: live });
  } else if (!live && pinned && pinned.id !== sessionId) {
    setPinned(null);
  }

  if (live) return live;
  return pinned?.id === sessionId ? pinned.session : undefined;
}
