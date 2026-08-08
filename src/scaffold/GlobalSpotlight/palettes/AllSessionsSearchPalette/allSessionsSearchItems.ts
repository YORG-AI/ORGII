import type { CrossSessionSearchHit } from "@src/api/tauri/rpc/schemas/sessionCore";
import type { Session } from "@src/store/session";
import {
  getSessionListDisplayName,
  resolveSessionRowIcon,
} from "@src/util/session/sessionSidebarRow";

import type { SpotlightItem } from "../../types";

interface BuildAllSessionsSearchItemsInput {
  hits: readonly CrossSessionSearchHit[];
  sessionMap: ReadonlyMap<string, Session>;
  fallbackSessionLabel: string;
  onNavigate: (
    sessionId: string,
    sessionName: string,
    repoPath: string
  ) => void;
}

/**
 * Adapt full-text cache hits to the shared Spotlight row contract. Snippets
 * use `desc` (the field the row renderer consumes), while icons reuse the
 * canonical session-row resolver so local, imported, Human, and agent-team
 * sessions remain visually consistent with the sidebar.
 */
export function buildAllSessionsSearchItems({
  hits,
  sessionMap,
  fallbackSessionLabel,
  onNavigate,
}: BuildAllSessionsSearchItemsInput): SpotlightItem[] {
  return hits.map((hit) => {
    const session = sessionMap.get(hit.sessionId);
    const sessionName = session
      ? getSessionListDisplayName(session, fallbackSessionLabel)
      : fallbackSessionLabel;

    return {
      id: hit.sessionId,
      label: sessionName,
      desc: hit.snippet.replace(/<\/?mark>/g, ""),
      icon: resolveSessionRowIcon(session ?? hit.sessionId),
      type: "option",
      data: { iconTone: "text1" },
      action: () =>
        onNavigate(hit.sessionId, sessionName, session?.repoPath ?? ""),
    };
  });
}
