import type { TFunction } from "i18next";
import { useAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";

import { supabaseSyncClient } from "@src/features/TeamCollaboration/sync/supabaseSyncClient";
import { collabChatMessagesAtom } from "@src/store/collaboration/collabOrgsAtom";
import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type {
  CollabChatMessageRecord,
  CollabMemberRecord,
  CollabOrgRecord,
} from "@src/store/collaboration/types";

import { CHAT_HISTORY_LIMIT } from "./constants";
import { createLocalChatMessageId, upsertChatMessage } from "./utils";

interface UseCollabOrgChatParams {
  org: CollabOrgRecord | undefined;
  orgMembers: CollabMemberRecord[];
  currentMember: CollabMemberRecord | undefined;
  t: TFunction<"navigation">;
}

export function useCollabOrgChat({
  org,
  orgMembers,
  currentMember,
  t,
}: UseCollabOrgChatParams) {
  const [chatMessages, setChatMessages] = useAtom(collabChatMessagesAtom);
  const [draftMessage, setDraftMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    if (!org?.supabaseUrl || !org.supabaseAnonKey || !org.orgSecret) return;
    let cancelled = false;
    supabaseSyncClient
      .listChatMessages({
        supabaseUrl: org.supabaseUrl,
        anonKey: org.supabaseAnonKey,
        orgSecret: org.orgSecret,
        orgId: org.id,
        limit: CHAT_HISTORY_LIMIT,
      })
      .then((messages) => {
        if (cancelled) return;
        setChatMessages((current) =>
          messages.reduce(upsertChatMessage, current)
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setChatError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [
    org?.id,
    org?.orgSecret,
    org?.supabaseAnonKey,
    org?.supabaseUrl,
    setChatMessages,
  ]);

  const handleSendMessage = useCallback(async () => {
    const body = draftMessage.trim();
    if (!body || !org || sending) return;
    setSending(true);
    setChatError(null);
    try {
      if (
        org.supabaseUrl &&
        org.supabaseAnonKey &&
        org.orgSecret &&
        currentMember
      ) {
        const message = await supabaseSyncClient.postChatMessage({
          supabaseUrl: org.supabaseUrl,
          anonKey: org.supabaseAnonKey,
          orgSecret: org.orgSecret,
          orgId: org.id,
          memberId: currentMember.id,
          authorDisplayName: currentMember.displayName,
          authorIdentityKind: currentMember.identityKind,
          body,
        });
        setChatMessages((current) => upsertChatMessage(current, message));
      } else {
        const author =
          currentMember ??
          orgMembers.find(
            (member) => member.identityKind === COLLAB_IDENTITY_KIND.HUMAN
          ) ??
          orgMembers[0];
        const message: CollabChatMessageRecord = {
          id: createLocalChatMessageId(org.id),
          orgId: org.id,
          authorMemberId: author?.id ?? "local-human",
          authorDisplayName:
            author?.displayName ?? t("collaboration.localHuman"),
          authorIdentityKind:
            author?.identityKind ?? COLLAB_IDENTITY_KIND.HUMAN,
          body,
          createdAt: new Date().toISOString(),
        };
        setChatMessages((current) => upsertChatMessage(current, message));
      }
      setDraftMessage("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }, [
    currentMember,
    draftMessage,
    org,
    orgMembers,
    sending,
    setChatMessages,
    t,
  ]);

  return {
    chatMessages,
    draftMessage,
    setDraftMessage,
    sending,
    chatError,
    handleSendMessage,
  };
}
