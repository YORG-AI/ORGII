// This type-only import is erased at build time, so the value import below
// remains lazy and xterm is still loaded only when the terminal mounts.
import type { TerminalCoreProps } from "@/src/engines/TerminalCore";
import {
  type UseTerminalStateReturn,
  getTerminalDisplayTitle,
} from "@/src/engines/TerminalCore/types";
import { useAtomValue, useSetAtom } from "jotai";
import React, { Suspense, memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import { ProcessStopButton } from "@src/components/ProcessStopButton";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";
import {
  FileHeader,
  TerminalInfoButton,
  TerminalNewSessionSplitButton,
} from "@src/modules/WorkStation/shared";
import {
  miniTerminalSuppressedIdsAtom,
  releaseMiniTerminalSessionAtom,
} from "@src/store/ui/miniTerminalAtom";
import {
  clearTerminalTargetReferencesAtom,
  codeEditorTerminalTargetAtom,
} from "@src/store/workstation/codeEditor";

import { resolveRestoredPtySessionId } from "./restorePtySelection";

const TerminalCore = React.lazy(() => import("@/src/engines/TerminalCore"));
const TerminalReadOnly = React.lazy(
  () => import("@src/engines/SessionCore/components/TerminalReadOnly")
);

interface TerminalMainContentProps {
  terminalState: UseTerminalStateReturn;
  repoPath?: string;
  onFileSelect?: (path: string) => void;
  onFileSelectWithLine?: (path: string, line: number) => void;
}

const TerminalMainContent: React.FC<TerminalMainContentProps> = ({
  terminalState,
  repoPath,
  onFileSelect,
  onFileSelectWithLine,
}) => {
  const { t } = useTranslation();
  const terminalTarget = useAtomValue(codeEditorTerminalTargetAtom);
  const setTerminalTarget = useSetAtom(codeEditorTerminalTargetAtom);
  const clearTerminalTargetReferences = useSetAtom(
    clearTerminalTargetReferencesAtom
  );
  // Sessions the trail's docked terminal currently mounts. One PTY can only
  // have one xterm, so this pane skips their mount and offers to take them
  // back instead.
  const suppressedSessionIds = useAtomValue(miniTerminalSuppressedIdsAtom);
  const releaseMiniTerminalSession = useSetAtom(releaseMiniTerminalSessionAtom);
  const renderSuppressedSession = useCallback(
    (sessionId: string) => (
      <Placeholder
        variant="empty"
        fillParentHeight
        title={t("common:git.rail.sessionInMiniTerminal")}
        action={{
          label: t("common:git.rail.returnFromMiniTerminal"),
          onClick: () => releaseMiniTerminalSession(sessionId),
        }}
      />
    ),
    [releaseMiniTerminalSession, t]
  );

  const activePtySession = terminalState.activeSession;
  const terminalKindLabel =
    terminalTarget?.kind === "agent"
      ? t("common:terminology.agentTerminal")
      : t("common:terminology.myTerminal");
  const displayTitle =
    terminalTarget?.kind === "agent"
      ? terminalTarget.sessionId
      : activePtySession
        ? getTerminalDisplayTitle(activePtySession)
        : terminalKindLabel;
  const headerPath = `${terminalKindLabel}/${displayTitle}`;
  const isAgentTerminal = terminalTarget?.kind === "agent";
  const terminalPid = activePtySession?.pid;
  const terminalShell = activePtySession?.shell ?? "zsh";
  const renderReadOnlySession = useCallback(
    (agentSessionId: string) => (
      <TerminalReadOnly agentSessionId={agentSessionId} />
    ),
    []
  );

  useEffect(() => {
    const restoredSessionId = resolveRestoredPtySessionId(
      terminalTarget,
      terminalState.sessions,
      terminalState.activeSessionId
    );
    if (restoredSessionId) {
      terminalState.setActiveSession(restoredSessionId);
    }
  }, [terminalState, terminalTarget]);

  const handleNewTerminal = useCallback(
    (options?: {
      shell?: string;
      args?: string[];
      name?: string;
      profileId?: string;
    }) => {
      const sessionId = terminalState.addSession({ ...options, cwd: repoPath });
      terminalState.setActiveSession(sessionId);
      setTerminalTarget({ kind: "pty", ptySessionId: sessionId });
    },
    [terminalState, repoPath, setTerminalTarget]
  );

  const handleKillTerminal = useCallback(() => {
    if (terminalTarget?.kind === "agent") {
      setTerminalTarget(null);
      return;
    }
    const ptySessionId =
      terminalTarget?.kind === "pty"
        ? terminalTarget.ptySessionId
        : terminalState.activeSessionId;
    terminalState.closeSession(ptySessionId);
    if (ptySessionId) clearTerminalTargetReferences(ptySessionId);
  }, [
    clearTerminalTargetReferences,
    setTerminalTarget,
    terminalState,
    terminalTarget,
  ]);

  const handleOpenFileLink = useCallback<
    NonNullable<TerminalCoreProps["onOpenFileLink"]>
  >(
    ({ path, line }) => {
      if (line && onFileSelectWithLine) {
        onFileSelectWithLine(path, line);
        return;
      }
      onFileSelect?.(path);
    },
    [onFileSelect, onFileSelectWithLine]
  );

  const terminalHeaderActions = useMemo(
    () => (
      <>
        {!isAgentTerminal && (
          <>
            <span className="flex items-center gap-px">
              <TerminalNewSessionSplitButton
                onNewTerminal={handleNewTerminal}
                splitMainWidth={24}
              />
            </span>
            <span
              className="pointer-events-none mx-1 h-4 w-px shrink-0 bg-border-2"
              aria-hidden
            />
          </>
        )}
        <span className="flex items-center gap-px">
          {isAgentTerminal ? (
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              title={t("common:actions.close")}
              aria-label={t("common:actions.close")}
              onClick={handleKillTerminal}
              icon={
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
              }
            />
          ) : (
            <ProcessStopButton
              label={t("common:tooltips.killTerminal")}
              onClick={handleKillTerminal}
            />
          )}
          {!isAgentTerminal && (
            <TerminalInfoButton
              title={t("common:terminology.myTerminalInfo")}
              name={displayTitle}
              pid={terminalPid}
              shell={terminalShell}
            />
          )}
        </span>
      </>
    ),
    [
      displayTitle,
      handleKillTerminal,
      handleNewTerminal,
      isAgentTerminal,
      t,
      terminalPid,
      terminalShell,
    ]
  );

  const terminalPane =
    terminalTarget?.kind === "agent" ? (
      <TerminalReadOnly agentSessionId={terminalTarget.sessionId} />
    ) : (
      <TerminalCore
        terminalState={terminalState}
        repoPath={repoPath}
        backgroundColor="var(--cm-editor-background)"
        onOpenFileLink={handleOpenFileLink}
        renderReadOnlySession={renderReadOnlySession}
        suppressedSessionIds={suppressedSessionIds}
        renderSuppressedSession={renderSuppressedSession}
      />
    );

  return (
    <div
      className={`relative h-full min-h-0 w-full ${EDITOR_TAB_CANVAS_BG_CLASS}`}
      data-action="terminal.execute"
    >
      <FileHeader
        filePath={headerPath}
        useFileTypeIcon={false}
        disableNavigation
        extraActions={terminalHeaderActions}
        publishToHost="code"
      />
      <Suspense
        fallback={
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        }
      >
        {terminalPane}
      </Suspense>
    </div>
  );
};

export default memo(TerminalMainContent);
