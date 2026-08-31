/**
 * Run group panel — the comparison surface for one multi-runner fan-out.
 *
 * Reads the stored group for "which runner produced which session", and the
 * live session store for everything else. The group record never caches
 * status, so this panel cannot show a stale run.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CANCEL_REASON, cancelSession } from "@src/api/tauri/agent/session";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import { resolveRunnerAgentDisplay } from "@src/features/SessionCreator/components/RunnerListPanel/resolveRunnerAgent";
import { collectRunGroupSessionIds } from "@src/features/SessionCreator/multiRunner/runGroupContract";
import { createLogger } from "@src/hooks/logger";
import { useAgentDefinitions } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentDefinitions";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import {
  openOrFocusChatPanelStartPageTabAtom,
  openOrFocusSessionInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { getSessionByIdAtom } from "@src/store/session";
import { seedLauncherFromRunGroupAtom } from "@src/store/session/multiRunnerAtom";
import { runGroupByIdAtom } from "@src/store/session/runGroupsAtom";

import RunGroupRunRow from "./RunGroupRunRow";
import { RUN_ROW_STATE, resolveRunRowState } from "./runGroupRow";

const log = createLogger("RunGroupPanel");

/** Elapsed times tick at this rate while at least one run is still alive. */
const ELAPSED_TICK_MS = 1_000;

export function RunGroupPanelView({
  runGroupId,
}: {
  runGroupId: string;
}): React.ReactNode {
  const { t } = useTranslation("sessions");
  const group = useAtomValue(runGroupByIdAtom(runGroupId));
  const getSessionById = useAtomValue(getSessionByIdAtom);
  const { builtInAgents, agents: customAgents } = useAgentDefinitions();
  const { agents: cliAgents } = useCliAgents({ enabled: true });
  const openSessionTab = useSetAtom(openOrFocusSessionInChatPanelTabAtom);
  const openStartPage = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const seedLauncher = useSetAtom(seedLauncherFromRunGroupAtom);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const allAgents = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );

  const unselectedLabel = t("creator.multiRunner.pickHarness");
  const rows = useMemo(
    () =>
      (group?.entries ?? []).map((entry) => {
        const session = entry.sessionId
          ? getSessionById(entry.sessionId)
          : undefined;
        return {
          entry,
          session,
          state: resolveRunRowState(entry, session),
          agentDisplay: resolveRunnerAgentDisplay(
            entry.runner,
            allAgents,
            cliAgents,
            unselectedLabel
          ),
        };
      }),
    [allAgents, cliAgents, getSessionById, group?.entries, unselectedLabel]
  );

  const liveSessionIds = useMemo(
    () =>
      rows.flatMap((row) =>
        row.state === RUN_ROW_STATE.RUNNING && row.entry.sessionId
          ? [row.entry.sessionId]
          : []
      ),
    [rows]
  );
  const hasLiveRuns = liveSessionIds.length > 0;

  // Only tick while something is actually running: a finished group is a
  // static list and has no reason to re-render once a second forever.
  useEffect(() => {
    if (!hasLiveRuns) return undefined;
    const intervalId = window.setInterval(
      () => setNowMs(Date.now()),
      ELAPSED_TICK_MS
    );
    return () => window.clearInterval(intervalId);
  }, [hasLiveRuns]);

  const handleOpen = useCallback(
    (sessionId: string) => {
      openSessionTab({ sessionId });
    },
    [openSessionTab]
  );

  const handleStop = useCallback(
    (sessionId: string) => {
      void cancelSession(sessionId, CANCEL_REASON.USER_STOP).catch(
        (error: unknown) => {
          log.warn("Failed to stop run", error);
          Message.error(t("runGroup.stopFailed"));
        }
      );
    },
    [t]
  );

  const handleStopAll = useCallback(() => {
    for (const sessionId of liveSessionIds) {
      void cancelSession(sessionId, CANCEL_REASON.USER_STOP).catch(
        (error: unknown) => log.warn("Failed to stop run", error)
      );
    }
  }, [liveSessionIds]);

  const handleRunAgain = useCallback(() => {
    if (!group) return;
    seedLauncher({
      prompt: group.prompt,
      runners: group.entries.map((entry) => entry.runner),
    });
    openStartPage();
  }, [group, openStartPage, seedLauncher]);

  const headerContent = useMemo(
    () => (
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[15px] font-semibold text-text-1">
          {group ? group.prompt : t("runGroup.missingTitle")}
        </span>
        {group && (
          <span className="shrink-0 text-[12px] text-text-3">
            {t("runGroup.subtitle", {
              count: collectRunGroupSessionIds(group).length,
              total: group.entries.length,
            })}
          </span>
        )}
      </div>
    ),
    [group, t]
  );
  usePublishChatPanelHeader({ content: { content: headerContent } });

  if (!group) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        subtitle={t("runGroup.missingBody")}
        fillParentHeight
      />
    );
  }

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      data-testid="run-group-panel"
    >
      <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div
          className={`mx-auto flex w-full flex-col gap-3 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-text-2">
              {group.prompt}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                appearance="outline"
                size="small"
                shape="round"
                onClick={handleRunAgain}
                data-testid="run-group-run-again"
              >
                {t("runGroup.runAgain")}
              </Button>
              {hasLiveRuns && (
                <Button
                  variant="tertiary"
                  size="small"
                  shape="round"
                  onClick={handleStopAll}
                  data-testid="run-group-stop-all"
                >
                  {t("runGroup.stopAll")}
                </Button>
              )}
            </div>
          </div>

          <ul className="flex flex-col" data-testid="run-group-run-list">
            {rows.map((row) => (
              <RunGroupRunRow
                key={row.entry.ordinal}
                entry={row.entry}
                agentDisplay={row.agentDisplay}
                session={row.session}
                state={row.state}
                nowMs={nowMs}
                onOpen={handleOpen}
                onStop={handleStop}
              />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default RunGroupPanelView;
