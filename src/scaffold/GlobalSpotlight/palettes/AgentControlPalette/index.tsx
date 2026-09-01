import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { sendAdeActionResult } from "@src/api/tauri/agent";
import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import { pendingSessionProposal } from "@src/engines/SessionCore/hooks/useAgentADEActions";
import SessionCreatorChatPanel from "@src/features/SessionCreator/variants/ChatPanel";
import { AiGenerativeIcon } from "@src/icons";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette";
import type { BasePaletteProps } from "@src/scaffold/GlobalSpotlight/shared";
import { modelSelectorAtom } from "@src/store/ui/modelSelectorAtom";

import { PaletteBody, SpotlightShell } from "../../shell";
import { AgentControlInputTrailing } from "./AgentControlInputTrailing";
import { AgentControlStatus } from "./AgentControlStatus";
import { AgentControlToolbar } from "./AgentControlToolbar";
import { useAgentControlPalette } from "./useAgentControlPalette";

export type { AdeManagerSubmitDetail } from "./types";
export {
  ADE_MANAGER_SUBMIT_EVENT,
  ADE_MANAGER_TOGGLE_SHORTCUT_ID,
} from "./constants";

// ── Proposal creator panel ────────────────────────────────────────────────────

const TOTAL_MS = 5 * 60 * 1000;

function useCountdown(expiresAt: number) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, expiresAt - Date.now())
  );
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, expiresAt - Date.now());
      setRemaining(left);
      if (left > 0) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [expiresAt]);
  const seconds = Math.ceil(remaining / 1000);
  const pct = remaining / TOTAL_MS;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const label =
    mins > 0 ? `${mins}:${String(secs).padStart(2, "0")}` : `${secs}s`;
  return { pct, label, expired: remaining === 0 };
}

interface ProposalCreatorPanelProps {
  expiresAt: number;
  task: string;
  onExpire: () => void;
}

const ProposalCreatorPanel: React.FC<ProposalCreatorPanelProps> = ({
  expiresAt,
  task,
  onExpire,
}) => {
  const { pct, label, expired } = useCountdown(expiresAt);
  useEffect(() => {
    if (expired) onExpire();
  }, [expired, onExpire]);

  const handleSessionStart = useCallback(
    (
      info: import("@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types").SessionLaunchSuccessInfo
    ) => {
      const proposal = pendingSessionProposal.current;
      if (proposal) {
        pendingSessionProposal.current = null;
        void sendAdeActionResult(proposal.correlationId, {
          success: true,
          message: `Session created: ${info.sessionId}`,
          data: { sessionId: info.sessionId },
        });
        window.dispatchEvent(
          new CustomEvent("ade-session-proposal-resolved", {
            detail: { correlationId: proposal.correlationId },
          })
        );
      }
    },
    []
  );

  const barColor =
    pct > 0.5 ? "bg-primary-6" : pct > 0.2 ? "bg-warning-5" : "bg-error-5";

  return (
    <div className="flex flex-col border-t border-border-2/50">
      {/* Countdown bar + timer */}
      <div className="flex items-center gap-2 px-3 py-1">
        <div className="relative h-[2px] flex-1 overflow-hidden rounded-full bg-border-2/40">
          <div
            className={`absolute left-0 top-0 h-full transition-none ${barColor}`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <span
          className={`shrink-0 font-mono text-[10px] tabular-nums ${
            pct <= 0.2 ? "text-error-5" : "text-text-3"
          }`}
        >
          {label}
        </span>
      </div>
      <SessionCreatorChatPanel
        initialContent={task}
        hidePresenceButton
        onSessionStart={handleSessionStart}
        innerClassName="!pb-3"
      />
    </div>
  );
};

interface AgentControlPaletteProps extends BasePaletteProps {
  asBody?: boolean;
}

export const AgentControlPalette: React.FC<AgentControlPaletteProps> = ({
  isOpen,
  onClose,
  onGoBackToParent,
  asBody = false,
}) => {
  const selectorState = useAtomValue(modelSelectorAtom);
  const setSelectorState = useSetAtom(modelSelectorAtom);
  const isModelOpen = selectorState.isOpen;
  const palette = useAgentControlPalette({ isOpen, onClose, onGoBackToParent });

  const handleOpenModelSelector = useCallback(() => {
    setSelectorState({ isOpen: true });
  }, [setSelectorState]);

  const inputTrailingSlot = (
    <AgentControlInputTrailing
      selection={palette.creatorDefaultLastModel}
      modelLabel={palette.modelLabel}
      selectModelLabel={palette.selectModelLabel}
      modelSelectorActive={isModelOpen}
      onOpenModelSelector={handleOpenModelSelector}
      submitDisabled={palette.submitDisabled}
      onSubmit={palette.handleSubmit}
    />
  );

  const paletteBody = (
    <>
      <PaletteBody
        kernel={palette.kernel}
        items={palette.items}
        path={palette.modePath}
        onRemoveSegment={onGoBackToParent ?? onClose}
        placeholder={palette.placeholder}
        inputTrailingSlot={inputTrailingSlot}
        contentOverride={null}
        inputIcon={AiGenerativeIcon}
      />
      {palette.showStatusLine && (
        <AgentControlStatus
          icon={palette.statusIcon}
          label={palette.statusLabel}
          detail={palette.statusDetail}
          spinning={palette.statusSpinning}
          isMarkdown={palette.statusIsMarkdown}
        />
      )}
      {palette.showSessionControls && (
        <AgentControlToolbar
          onNewRound={palette.handleRefreshSession}
          onPreviousActivity={palette.handlePreviousActivity}
          onNextActivity={palette.handleNextActivity}
          onLatestActivity={palette.handleLatestActivity}
          hasPreviousActivity={palette.hasPreviousActivity}
          hasNextActivity={palette.hasNextActivity}
          previousIcon={palette.toolbarActions.previousIcon}
          nextIcon={palette.toolbarActions.nextIcon}
          latestIcon={palette.toolbarActions.latestIcon}
        />
      )}
    </>
  );

  // When ADE Manager proposes a session, append the creator below the
  // existing ADE input + message history — don't replace them.
  const proposalCreator = palette.pendingProposal ? (
    <ProposalCreatorPanel
      expiresAt={palette.pendingProposal.expiresAt}
      task={palette.pendingProposal.task}
      onExpire={palette.handleDismissProposal}
    />
  ) : null;

  const body = (
    <>
      {paletteBody}
      {proposalCreator}
    </>
  );

  return (
    <>
      {asBody ? (
        body
      ) : (
        <SpotlightShell isOpen={isOpen} onClose={onClose} hideFooter>
          {body}
        </SpotlightShell>
      )}
      <UnifiedModelPalette
        isOpen={isModelOpen}
        onClose={palette.handleCloseModelSelector}
        advancedConfig={palette.creatorDefaultLastModel ?? {}}
        onConfigChange={palette.handleModelConfigChange}
        dispatchCategoryOverride={DISPATCH_CATEGORY.RUST_AGENT}
      />
    </>
  );
};

export default AgentControlPalette;
