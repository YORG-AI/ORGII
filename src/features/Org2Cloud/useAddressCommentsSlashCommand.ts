/** Slash-menu bridge for the owner-only single/multi comment agent runner. */
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { SlashItem } from "@src/types/extensions";

import { collectAddressableThreads } from "./addressComments";
import type { AddressCommentScope } from "./addressComments";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { sessionCommentsKey } from "./org2CloudCommentsBus";
import {
  org2CloudSessionCommentsAtom,
  sessionCommentsEntryForIdentity,
} from "./org2CloudSessionCommentsAtom";
import { useSessionCommentTarget } from "./sessionCommentTarget";
import { useOwnedCloudCommentAgentRun } from "./useOwnedCloudCommentAgentRun";

export const ADDRESS_COMMENTS_SLASH_SOURCE = "org2cloud-address-comments";

export interface AddressCommentsThreadOption {
  id: string;
  author: string;
  body: string;
  scope: AddressCommentScope;
}

export interface AddressCommentsRunOptions {
  selectedHeadIds?: readonly string[];
  instruction?: string;
}

export interface AddressCommentsSlashCommand {
  item: SlashItem | null;
  available: boolean;
  threads: AddressCommentsThreadOption[];
  run: (options?: AddressCommentsRunOptions) => void;
}

export function useAddressCommentsSlashCommand(
  sessionId: string | null | undefined
): AddressCommentsSlashCommand {
  const { t } = useTranslation("navigation");
  const sessions = useAtomValue(sessionsAtom);
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const commentEntries = useAtomValue(org2CloudSessionCommentsAtom);

  const session = useMemo(
    () =>
      sessionId
        ? (sessions.find((candidate) => candidate.session_id === sessionId) ??
          null)
        : null,
    [sessions, sessionId]
  );
  const target = useSessionCommentTarget(session);
  const storedCommentEntry = target
    ? commentEntries[sessionCommentsKey(target.orgId, target.sessionId)]
    : undefined;
  const commentEntry = sessionCommentsEntryForIdentity(
    storedCommentEntry,
    authIdentityKey
  );

  const threads = useMemo<AddressCommentsThreadOption[]>(() => {
    if (!target) return [];
    const entry = commentEntry;
    if (!entry) return [];
    return collectAddressableThreads(entry.comments).map((thread) => ({
      id: thread.headId,
      author: thread.headAuthor,
      body: thread.headBody,
      scope: thread.scope,
    }));
  }, [target, commentEntry]);

  const { available: ownerAgentAvailable, run: runOwnerAgent } =
    useOwnedCloudCommentAgentRun({
      session,
      target,
      viewerOwnsSession: Boolean(commentEntry?.viewerOwnsSession),
    });
  const available = ownerAgentAvailable && threads.length > 0;

  const item = useMemo<SlashItem | null>(
    () =>
      available
        ? {
            name: t("cloud.comments.addressButton"),
            description: "",
            category: "action",
            source: ADDRESS_COMMENTS_SLASH_SOURCE,
            acceptsArgs: true,
          }
        : null,
    [available, t]
  );

  const run = useCallback(
    (options?: AddressCommentsRunOptions) => {
      if (!target || !session) return;
      void runOwnerAgent(options);
    },
    [runOwnerAgent, session, target]
  );

  return { item, available, threads, run };
}
