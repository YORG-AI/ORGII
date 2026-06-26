import {
  type TerminalCoreProps,
  type UseTerminalStateReturn,
  getTerminalDisplayTitle,
} from "@/src/engines/TerminalCore/exports";
import { useAtomValue, useSetAtom } from "jotai";
import { Trash2 } from "lucide-react";
import React, { Suspense, memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import {
  FileHeader,
  TerminalInfoButton,
  TerminalNewSessionSplitButton,
} from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { codeEditorTerminalTargetAtom } from "@src/store/workstation/codeEditor";

const TerminalCore = React.lazy(
  () => import("@/src/engines/TerminalCore/exports")
);
const TerminalReadOnly = React.lazy(
  () => import("@src/components/TerminalReadOnly")
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
    terminalState.closeSession(terminalState.activeSessionId);
    setTerminalTarget(null);
  }, [terminalState, terminalTarget, setTerminalTarget]);

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
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            title={t("tooltips.killTerminal")}
            onClick={handleKillTerminal}
            icon={<Trash2 size={14} />}
          />
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
