import React, { Suspense, useCallback, useState } from "react";

import { SESSION_CREATOR_LAUNCH_MODE } from "@src/features/SessionCreator/types";
import { CHAT_PANEL_CREATE_TARGET } from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

import type { ChatPanelProps, ChatPanelRegionNotice } from "./types";

const StartPageWorkItemComposerChrome = React.lazy(
  () => import("./StartPageWorkItemComposerChrome")
);

type SessionCreatorSlot = NonNullable<ChatPanelProps["sessionCreatorSlot"]>;
type SessionCreatorSlotProps = React.ComponentProps<SessionCreatorSlot>;

type StartPageAgentCreateTarget =
  | typeof CHAT_PANEL_CREATE_TARGET.AGENT_SESSION
  | typeof CHAT_PANEL_CREATE_TARGET.WORK_ITEM;

export interface DefaultAiWorkItemExecutionTarget {
  id: string;
  name: string;
  type: "agent" | "org";
  agentDefinitionId?: string;
}

interface StartPageAgentComposerProps {
  createTarget: StartPageAgentCreateTarget;
  creatorModeControl: React.ReactNode;
  creatorVariant: "default" | "fullScreen";
  defaultAiWorkItemExecutionTarget: DefaultAiWorkItemExecutionTarget | null;
  handleAiWorkItemSessionStart: NonNullable<
    SessionCreatorSlotProps["onSessionStart"]
  >;
  handleOpenCliTerminal: NonNullable<
    SessionCreatorSlotProps["onOpenCliTerminal"]
  >;
  handleRegionNoticeChange: (notice: ChatPanelRegionNotice | null) => void;
  handleStartPageSessionStart: NonNullable<
    SessionCreatorSlotProps["onSessionStart"]
  >;
  heroFooterSlot: React.ReactNode;
  launchpadActionsVisible: boolean;
  onDraftChange: (draft: WorkItemDraft) => void;
  orgId?: string;
  resolveAiWorkItemContext: NonNullable<
    SessionCreatorSlotProps["resolveWorkItemContext"]
  >;
  SessionCreatorSlot: SessionCreatorSlot;
}

/**
 * One stable SessionCreator owner for the Session and agent-assisted Work Item
 * tabs. Switching targets changes only the launch contract and composer chrome;
 * the editor, draft restoration, repository state, and creator hooks stay
 * mounted at the same React position.
 */
export function StartPageAgentComposer({
  createTarget,
  creatorModeControl,
  creatorVariant,
  defaultAiWorkItemExecutionTarget,
  handleAiWorkItemSessionStart,
  handleOpenCliTerminal,
  handleRegionNoticeChange,
  handleStartPageSessionStart,
  heroFooterSlot,
  launchpadActionsVisible,
  onDraftChange,
  orgId,
  resolveAiWorkItemContext,
  SessionCreatorSlot,
}: StartPageAgentComposerProps): React.ReactNode {
  const isWorkItem = createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM;
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const [pinnedActionsHost, setPinnedActionsHost] =
    useState<HTMLDivElement | null>(null);
  const handleHeaderHostRef = useCallback((node: HTMLDivElement | null) => {
    setHeaderHost(node);
  }, []);
  const handlePinnedActionsHostRef = useCallback(
    (node: HTMLDivElement | null) => {
      setPinnedActionsHost(node);
    },
    []
  );

  const composerHeaderContent = isWorkItem ? (
    <div ref={handleHeaderHostRef} className="contents" />
  ) : undefined;
  const pinnedActionsContent = isWorkItem ? (
    <div ref={handlePinnedActionsHostRef} className="contents" />
  ) : undefined;

  return (
    <>
      <SessionCreatorSlot
        className="h-full min-h-0 flex-1"
        variant={creatorVariant}
        layout="launchpad"
        launchpadIntent={isWorkItem ? "plan" : "build"}
        composerHeaderContent={composerHeaderContent}
        heroFooterSlot={isWorkItem ? undefined : heroFooterSlot}
        pinnedActionsContent={pinnedActionsContent}
        hidePresenceButton
        hideWorkItemAttachmentControl={isWorkItem || !launchpadActionsVisible}
        includeHumanSession={isWorkItem ? false : undefined}
        launchMode={
          isWorkItem ? SESSION_CREATOR_LAUNCH_MODE.START_BACKGROUND : undefined
        }
        onOpenCliTerminal={handleOpenCliTerminal}
        onRegionNoticeChange={handleRegionNoticeChange}
        onSessionStart={
          isWorkItem
            ? handleAiWorkItemSessionStart
            : handleStartPageSessionStart
        }
        resolveWorkItemContext={
          isWorkItem ? resolveAiWorkItemContext : undefined
        }
      />
      {isWorkItem ? (
        <Suspense fallback={null}>
          <StartPageWorkItemComposerChrome
            creatorModeControl={creatorModeControl}
            defaultAiWorkItemExecutionTarget={defaultAiWorkItemExecutionTarget}
            headerHost={headerHost}
            onDraftChange={onDraftChange}
            orgId={orgId}
            pinnedActionsHost={pinnedActionsHost}
          />
        </Suspense>
      ) : null}
    </>
  );
}
