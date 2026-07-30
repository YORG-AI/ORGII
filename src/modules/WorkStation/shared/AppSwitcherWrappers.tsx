/**
 * Product-bound app switcher wrappers
 *
 * Thin components that read product-specific data from hooks and pipe it into
 * the shared {@link AppSwitcherChip} view. Use these directly at call sites —
 * they hide the data hook plumbing behind a zero-prop component.
 */
import { useAtomValue } from "jotai";
import { Monitor } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { RUST_AGENT_TYPE } from "@src/api/tauri/agent/types";
import { CLI_AGENT, type CliAgentType } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import { useAgentOrgMemberSessionJump } from "@src/engines/ChatPanel/InputArea/components/useAgentOrgMemberSessionJump";
import { useAgentOrgRunView } from "@src/engines/ChatPanel/InputArea/components/useAgentOrgRunView";
import {
  activeSessionIdAtom,
  sessionMapAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { isAgentOrgMemberEmpty } from "@src/util/agentOrg/memberActivity";
import {
  getRustAgentType,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

import { AppSwitcherChip } from "./AppSwitcherChip";
import { StationTabBarLeading } from "./StationTabBarLeading";
import { TabBarLeadingLayout } from "./TabBarLeadingLayout";
import { useSimulatorAppSwitcher } from "./useAppSwitcherData";

interface AppSwitcherChipWrapperProps {
  /** Hide the chip (CSS-only) — prevents mount/unmount flash. */
  hidden?: boolean;
}

interface WorkstationAgentLabels {
  cursor: string;
  claude: string;
  sde: string;
  os: string;
  wingman: string;
  generic: string;
}

function getAgentWorkstationName(
  sessionId: string | null,
  labels: WorkstationAgentLabels,
  session?: { agentDisplayName?: string; cliAgentType?: CliAgentType }
): string {
  if (session?.cliAgentType === CLI_AGENT.CURSOR) return labels.cursor;
  if (session?.cliAgentType === CLI_AGENT.CLAUDE_CODE) return labels.claude;
  if (session?.cliAgentType) return formatAgentType(session.cliAgentType);

  if (session?.agentDisplayName) return session.agentDisplayName;
  if (isCursorIdeSession(sessionId)) return labels.cursor;

  const rustAgentType = getRustAgentType(sessionId);
  if (rustAgentType === RUST_AGENT_TYPE.SDE) return labels.sde;
  if (rustAgentType === RUST_AGENT_TYPE.OS) return labels.os;
  if (rustAgentType === RUST_AGENT_TYPE.WINGMAN) return labels.wingman;
  return labels.generic;
}

const SimulatorAppSwitcherChipComponent: React.FC<
  AppSwitcherChipWrapperProps
> = ({ hidden = false }) => {
  const data = useSimulatorAppSwitcher();
  if (!data.label) return null;
  return (
    <AppSwitcherChip
      hidden={hidden}
      icon={data.icon}
      label={data.label}
      activeId={data.activeId}
      items={data.items}
      onSelect={data.onSelect}
      closeOnChange={data.activeId}
    />
  );
};

// Internal to this module: rendered by SimulatorTabBarLeading below. No longer
// re-exported from the shared barrel (nothing outside imports it directly).
const SimulatorAppSwitcherChip = memo(SimulatorAppSwitcherChipComponent);
SimulatorAppSwitcherChip.displayName = "SimulatorAppSwitcherChip";

function memberSessionId(member: AgentOrgRunMemberView): string | null {
  return member.sessionRuntime?.sessionId ?? null;
}

const SimulatorAgentChipComponent: React.FC = () => {
  const { t } = useTranslation("navigation");
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const workstationSessionId = useAtomValue(workstationActiveSessionIdAtom);
  const sessionId = activeSessionId ?? workstationSessionId;
  const sessionMap = useAtomValue(sessionMapAtom);
  const session = sessionId ? sessionMap.get(sessionId) : undefined;
  const labels: WorkstationAgentLabels = {
    cursor: t("workstation.agentComputer.agents.cursor"),
    claude: t("workstation.agentComputer.agents.claude"),
    sde: t("workstation.agentComputer.agents.sde"),
    os: t("workstation.agentComputer.agents.os"),
    wingman: t("workstation.agentComputer.agents.wingman"),
    generic: t("workstation.agentComputer.agents.generic"),
  };
  const fallbackAgentName = getAgentWorkstationName(sessionId, labels, session);

  // Agent-Org members for the current session. The coordinator is rendered
  // as its own "Coordinator" entry rather than collapsed into "All agents"
  // — selecting it jumps back to the parent session's stream. Non-org
  // sessions return null → chip stays in its `{{agent}}'s Workstation` form.
  const { view: agentOrgRunView } = useAgentOrgRunView(sessionId);
  const jumpToMember = useAgentOrgMemberSessionJump(sessionId ?? "");

  const switchableMembers = useMemo(
    () =>
      (agentOrgRunView?.members ?? []).filter(
        (member) => memberSessionId(member) !== null
      ),
    [agentOrgRunView]
  );

  const coordinatorMember = useMemo(
    () => switchableMembers.find((member) => member.isCoordinator) ?? null,
    [switchableMembers]
  );

  // Current member resolution. Prefer the run view's own `currentMemberId`
  // (set by the backend based on the session being viewed); fall back to
  // matching by sessionId so the chip still reflects the active session
  // when the run view hasn't loaded yet.
  const currentMember = useMemo(() => {
    if (!agentOrgRunView) return null;
    if (agentOrgRunView.currentMemberId) {
      return (
        switchableMembers.find(
          (member) => member.memberId === agentOrgRunView.currentMemberId
        ) ?? null
      );
    }
    if (!sessionId) return null;
    return (
      switchableMembers.find(
        (member) => memberSessionId(member) === sessionId
      ) ?? null
    );
  }, [agentOrgRunView, switchableMembers, sessionId]);

  // Read "No tasks" from the sessions namespace so it stays in lockstep
  // with the same label used by ChatHistory's TurnPaginationControls.
  const noTasksLabel = t("sessions:planner.agentOrgMemberStatus.noTasks", {
    defaultValue: "No tasks",
  });

  const items = useMemo(() => {
    if (switchableMembers.length <= 1) return [];
    const result: {
      id: string;
      label: string;
      trailingLabel?: string;
      disabled?: boolean;
    }[] = [];
    if (coordinatorMember) {
      const id = memberSessionId(coordinatorMember);
      if (id) {
        // Coordinator is always selectable. Use the canonical English
        // role label ("Coordinator") so the simulator and chat-panel
        // pickers stay visually identical regardless of UI locale.
        result.push({ id, label: "Coordinator" });
      }
    }
    // Stable sort: members with at least one task or unread inbox item first,
    // empty members last. Switching to a member with no tasks and no inbox
    // activity would open an empty chat panel (no events) which surfaces a
    // "session may not have loaded" reload prompt — disable those rows so the
    // user can't reach that dead end.
    const nonCoordinators = switchableMembers.filter(
      (member) => !member.isCoordinator
    );
    const withEmptyState = nonCoordinators.map((member) => {
      const hasNoTasksAndNoInbox = isAgentOrgMemberEmpty(member);
      return { member, hasNoTasksAndNoInbox };
    });
    withEmptyState.sort((a, b) => {
      if (a.hasNoTasksAndNoInbox === b.hasNoTasksAndNoInbox) return 0;
      return a.hasNoTasksAndNoInbox ? 1 : -1;
    });
    for (const { member, hasNoTasksAndNoInbox } of withEmptyState) {
      const id = memberSessionId(member);
      if (!id) continue;
      result.push({
        id,
        // No icon — matches the icon-less chat-panel member switcher.
        // Member name is shown verbatim (no role localization).
        label: member.name,
        trailingLabel: hasNoTasksAndNoInbox ? noTasksLabel : undefined,
        disabled: hasNoTasksAndNoInbox,
      });
    }
    return result;
  }, [coordinatorMember, noTasksLabel, switchableMembers]);

  // Chip's visible label: in org mode mirror the dropdown's verbatim
  // labels (coordinator → "Coordinator", otherwise the member's own
  // name). In non-org mode keep the historical "{{agent}}'s Workstation".
  const chipLabel = useMemo(() => {
    if (items.length > 1) {
      if (currentMember?.isCoordinator) return "Coordinator";
      if (currentMember) return currentMember.name;
      return "Coordinator";
    }
    return t("workstation.agentComputer.label", { agent: fallbackAgentName });
  }, [currentMember, fallbackAgentName, items.length, t]);

  const handleSelect = (id: string) => {
    if (id === sessionId) return;
    const member = switchableMembers.find((m) => memberSessionId(m) === id);
    if (!member) return;
    jumpToMember(member);
  };

  return (
    <AppSwitcherChip
      icon={Monitor}
      label={chipLabel}
      activeId={sessionId ?? "agent-workstation"}
      items={items}
      onSelect={handleSelect}
      testId="simulator-agent-chip"
      closeOnChange={sessionId}
    />
  );
};

export const SimulatorAgentChip = memo(SimulatorAgentChipComponent);
SimulatorAgentChip.displayName = "SimulatorAgentChip";

/**
 * Tab-bar `leadingSlot` content for simulator replay views: app-switcher
 * chip only. The agent (member/Coordinator) switcher is already rendered
 * once at the top of the station shell by {@link AgentStationTopHeader},
 * so duplicating it here just stacks two identical pills above the
 * simulator. The primary-sidebar toggle lives in the global
 * {@link SimulatorWorkstationTabHeader} strip below the tab bar —
 * matches the My Station shell.
 */
const SimulatorTabBarLeadingComponent: React.FC = () => (
  <TabBarLeadingLayout>
    <SimulatorAppSwitcherChip />
  </TabBarLeadingLayout>
);

export const SimulatorTabBarLeading = memo(SimulatorTabBarLeadingComponent);
SimulatorTabBarLeading.displayName = "SimulatorTabBarLeading";

/**
 * Tab-bar `leadingSlot` content for My Station: the station-mode chip only.
 * Host switching is tab-driven (see `activeHostAtom`), so no per-app switcher
 * chip is rendered here. The primary-sidebar toggle lives in the global
 * {@link WorkstationTabHeader} strip below the tab bar, not here.
 */
const WorkStationTabBarLeadingComponent: React.FC = () => (
  <StationTabBarLeading />
);

export const WorkStationTabBarLeading = memo(WorkStationTabBarLeadingComponent);
WorkStationTabBarLeading.displayName = "WorkStationTabBarLeading";
