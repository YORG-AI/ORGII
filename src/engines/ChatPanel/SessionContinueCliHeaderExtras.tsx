import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadAvailableAgents } from "@src/api/services/availableAgents";
import {
  appendCliCommandArgs,
  cliAgentCreateTuiSession,
  deriveExpectedProcess,
  resolveCliTuiCommand,
} from "@src/api/tauri/agent/cliTerminalSession";
import {
  type ExternalHistoryCliResumePlan,
  externalHistoryCliResumePlan,
  getImportedHistoryCliResume,
} from "@src/api/tauri/externalHistory";
import type { CliAgentType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Tooltip from "@src/components/Tooltip";
import type { AvailableAgent } from "@src/config/cliAgents";
import type { ChatPanelCliTerminalLaunchOptions } from "@src/engines/ChatPanel/types";
import { createLogger } from "@src/hooks/logger";
import { HugeiconsIcon, SquareTerminalIcon } from "@src/icons";
import type { Session } from "@src/store/session/sessionAtom/types";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

const log = createLogger("ChatPanel");

export interface SessionContinueCliHeaderExtrasProps {
  session: Session | null;
  sessionId: string | null;
  onOpenCliTerminal?: (options: ChatPanelCliTerminalLaunchOptions) => void;
}

/**
 * "Continue in <CLI>" header action for imported external sessions.
 *
 * The imported transcript stays read-only inside ORGII, but the CLI that
 * wrote it can reopen the very conversation (`claude --resume`,
 * `codex resume`, `cursor-agent --resume`). This button hands the session
 * back to that CLI inside a chat-panel terminal tab, backed by a managed
 * TUI session row so worktree cwd, live status, and the managed-mirror
 * dedup behave exactly like a GUI-launched CLI session.
 */
const SessionContinueCliHeaderExtras: React.FC<
  SessionContinueCliHeaderExtrasProps
> = ({ session, sessionId, onOpenCliTerminal }) => {
  const { t } = useTranslation("navigation");
  const [plan, setPlan] = useState<ExternalHistoryCliResumePlan | null>(null);
  const [agent, setAgent] = useState<AvailableAgent | undefined>(undefined);
  const [agentKnown, setAgentKnown] = useState(false);
  const [launching, setLaunching] = useState(false);

  const isImported = Boolean(sessionId && isImportedHistorySession(sessionId));
  // Sync capability gate: sources without a CLI resume path never render
  // the button, and never pay the backend plan round-trip. The backend
  // stays authoritative for per-session cases (subagents, odd ids).
  const descriptorCliResume = getImportedHistoryCliResume(sessionId);

  useEffect(() => {
    setPlan(null);
    if (!sessionId || !isImported || !descriptorCliResume) return undefined;
    let cancelled = false;
    externalHistoryCliResumePlan(sessionId)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((error) => {
        log.warn("external CLI resume plan failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, isImported, descriptorCliResume]);

  useEffect(() => {
    setAgent(undefined);
    setAgentKnown(false);
    if (!plan) return undefined;
    let cancelled = false;
    loadAvailableAgents()
      .then((agents) => {
        if (cancelled) return;
        setAgent(agents.find((entry) => entry.name === plan.cliAgentType));
        setAgentKnown(true);
      })
      .catch((error) => {
        // Unknown availability degrades to "try it": the terminal itself
        // surfaces a command-not-found, which is more actionable than a
        // silently missing button.
        log.warn("CLI registry load failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [plan]);

  const agentDisplayName = useMemo(() => {
    if (!plan) return "";
    return (
      agent?.displayName ??
      descriptorCliResume?.displayName ??
      plan.defaultBinary
    );
  }, [agent, descriptorCliResume, plan]);

  const disabledReason = useMemo(() => {
    if (!plan) return null;
    if (agentKnown && agent && !agent.installed) {
      return t("collaboration.continueCli.notInstalled", {
        agent: agentDisplayName,
      });
    }
    if (!plan.sourceAvailable) {
      return t("collaboration.continueCli.sourceMissing");
    }
    if (plan.requiresCwd && (!plan.cwd || !plan.cwdExists)) {
      return t("collaboration.continueCli.missingWorkspace", {
        agent: agentDisplayName,
      });
    }
    return null;
  }, [agent, agentDisplayName, agentKnown, plan, t]);

  const handleContinue = useCallback(async (): Promise<void> => {
    if (!plan || !onOpenCliTerminal || launching) return;
    setLaunching(true);
    try {
      const cliAgentType = plan.cliAgentType as CliAgentType;
      const detectedCommand = agent?.command.trim() || plan.defaultBinary;
      const baseCommand = await resolveCliTuiCommand(
        cliAgentType,
        detectedCommand
      );
      const command = appendCliCommandArgs(baseCommand, plan.resumeArgs);
      const cwd = plan.cwd && plan.cwdExists ? plan.cwd : undefined;
      const title = session?.name || agentDisplayName;
      // Back the terminal with a managed session row so lifecycle hooks can
      // attribute status/transcripts via ORGII_SESSION_ID and the imported
      // twin dedupes through the managed mirror. Creation failure degrades
      // to an unbound terminal rather than blocking the resume.
      let agentSessionId: string | undefined;
      try {
        const created = await cliAgentCreateTuiSession({
          platform: cliAgentType,
          name: title,
          repoPath: cwd,
        });
        agentSessionId = created.sessionId;
      } catch (error) {
        log.warn(
          "TUI session create failed; opening unbound resume terminal",
          error
        );
      }
      onOpenCliTerminal({
        cliAgentType,
        command,
        title,
        cwd,
        agentSessionId,
        expectedProcess: deriveExpectedProcess(baseCommand),
      });
    } catch (error) {
      log.error("failed to continue imported session in its CLI", error);
      Message.error(
        t("collaboration.continueCli.launchFailed", {
          agent: agentDisplayName,
        })
      );
    } finally {
      setLaunching(false);
    }
  }, [
    agent,
    agentDisplayName,
    launching,
    onOpenCliTerminal,
    plan,
    session?.name,
    t,
  ]);

  if (!isImported || !plan || !onOpenCliTerminal) return null;

  const continueLabel = t("collaboration.continueCli.headerButton", {
    agent: agentDisplayName,
  });
  const tooltipContent =
    disabledReason ??
    t("collaboration.continueCli.headerTooltip", {
      agent: agentDisplayName,
      command: plan.displayCommand,
    });

  return (
    <Tooltip
      content={tooltipContent}
      position="bottom-end"
      mouseEnterDelay={200}
      framedPanel
    >
      <span className="inline-flex">
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          loading={launching}
          disabled={Boolean(disabledReason)}
          onClick={() => void handleContinue()}
          aria-label={continueLabel}
          data-testid="session-continue-cli-button"
          icon={
            <HugeiconsIcon
              icon={SquareTerminalIcon}
              data-icon="terminal-square"
              size={14}
              strokeWidth={2}
            />
          }
        />
      </span>
    </Tooltip>
  );
};

export default SessionContinueCliHeaderExtras;
