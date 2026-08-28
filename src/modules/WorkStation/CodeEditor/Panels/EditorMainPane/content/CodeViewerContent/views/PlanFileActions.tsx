/**
 * PlanFileActions — "Execute Plan" button shown in the FileHeader
 * when a .plan.md file is open in the editor.
 *
 * Uses the current editor content (planContent prop) so that
 * user edits to the plan file are respected on execute.
 */
import { useAtomValue } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { isOwnKey } from "@src/api/tauri/session";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { PlanExecutionService } from "@src/engines/SessionCore/services/PlanExecutionService";
import { createLogger } from "@src/hooks/logger";
import { useSessionExecModeField } from "@src/hooks/session/useSessionPatch";
import { HugeiconsIcon, PlayIcon } from "@src/icons";
import { creatorDefaultModelSelectionAtom } from "@src/store/session/creatorDefaultModelAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { isAgentSession } from "@src/util/session/sessionDispatch";

const log = createLogger("PlanFileActions");

interface PlanFileActionsProps {
  planContent: string;
}

export const PlanFileActions: React.FC<PlanFileActionsProps> = memo(
  ({ planContent }) => {
    const { t } = useTranslation("sessions");
    const sessionId = useAtomValue(activeSessionIdAtom);
    const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
    const { setMode: setSessionExecMode } = useSessionExecModeField(
      sessionId ?? ""
    );
    const creatorDefaultSelection = useAtomValue(
      creatorDefaultModelSelectionAtom
    );
    const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);

    const handleExecute = useCallback(() => {
      if (!sessionId || !isAgentSession(sessionId)) {
        Message.error(t("planner.plan.noActiveSession"));
        return;
      }

      const trimmed = planContent.trim();
      if (!trimmed) {
        Message.error("Plan file is empty");
        return;
      }

      // Persist mode=build on this session, not as a global default.
      // Fire-and-forget; the dispatch below pins `mode: "build"`
      // on the wire too so the call is correct even if the patch is
      // still in flight.
      void setSessionExecMode("build");

      // Prefer the session row's own-key model+account; fall back to
      // the creator-default selection only if the session has no
      // model yet (very fresh agent session, no model picker run).
      const sessionKeySource =
        session?.keySource ?? creatorDefaultSelection?.keySource;
      const useSession = session?.model && isOwnKey(sessionKeySource);
      const model = useSession
        ? session?.model
        : creatorDefaultSelection != null &&
            isOwnKey(creatorDefaultSelection.keySource)
          ? creatorDefaultSelection.model
          : undefined;
      const accountId = useSession
        ? session?.accountId
        : creatorDefaultSelection != null &&
            isOwnKey(creatorDefaultSelection.keySource)
          ? creatorDefaultSelection.selectedAccountId
          : undefined;
      const activeRepoPath = session?.repoPath ?? activeWorkspaceRootPath;

      PlanExecutionService.executePlanDocument({
        sessionId,
        planContent: trimmed,
        model,
        accountId,
        workspacePath: activeRepoPath,
        mode: "build",
      }).catch((err: unknown) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error("[PlanFileActions] Agent message error:", errorMsg);
        Message.error(errorMsg);
      });
    }, [
      sessionId,
      session,
      planContent,
      setSessionExecMode,
      creatorDefaultSelection,
      activeWorkspaceRootPath,
      t,
    ]);

    if (!sessionId || !isAgentSession(sessionId) || !planContent.trim()) {
      return null;
    }

    return (
      <Button
        variant="primary"
        size="mini"
        onClick={handleExecute}
        icon={<HugeiconsIcon icon={PlayIcon} data-icon="play" size={12} />}
      >
        {t("planner.plan.executePlan")}
      </Button>
    );
  }
);

PlanFileActions.displayName = "PlanFileActions";
