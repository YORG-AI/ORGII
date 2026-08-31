import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import {
  chatEventsForSessionAtomFamily,
  sessionSnapshotAtomFamily,
} from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import {
  type CommentAnchorEventIdentity,
  areCommentAnchorIdentitiesEqual,
  toCommentAnchorIdentities,
} from "@src/features/Org2Cloud/SessionComments/commentAnchorIdentities";

const EMPTY_IDENTITIES: CommentAnchorEventIdentity[] = [];

/**
 * Pipeline-scoped comment-anchor identities for the active session.
 *
 * Comments only need event id + source. Selecting that slice here keeps
 * ChatViewLiveRegion and SessionCommentsProvider off token-only
 * `displayText` churn on the full chatEvents array.
 */
export function usePipelineChatEvents(): {
  pipelineSessionId: string | null;
  commentAnchors: CommentAnchorEventIdentity[];
  transcriptReady: boolean;
} {
  const pipelineSessionId = useAtomValue(sessionIdAtom);

  const commentAnchorsAtom = useMemo(
    () =>
      selectAtom(
        chatEventsForSessionAtomFamily(pipelineSessionId ?? "__none__"),
        toCommentAnchorIdentities,
        areCommentAnchorIdentitiesEqual
      ),
    [pipelineSessionId]
  );
  const commentAnchors = useAtomValue(commentAnchorsAtom);

  const transcriptReadyAtom = useMemo(
    () =>
      selectAtom(
        sessionSnapshotAtomFamily(pipelineSessionId ?? "__none__"),
        (state) => state.loadStarted
      ),
    [pipelineSessionId]
  );
  const transcriptReady = useAtomValue(transcriptReadyAtom);

  return {
    pipelineSessionId,
    commentAnchors: pipelineSessionId ? commentAnchors : EMPTY_IDENTITIES,
    transcriptReady: Boolean(pipelineSessionId && transcriptReady),
  };
}
