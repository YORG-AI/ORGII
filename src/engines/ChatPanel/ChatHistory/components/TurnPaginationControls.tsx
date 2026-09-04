/**
 * TurnPaginationControls
 *
 * Top-of-history toolbar that hosts the Agent Team member label, round
 * selector, current time-range label, and previous / next / last-round
 * buttons.
 */
import React, { memo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import TurnNavigationToolbar from "@src/components/TurnNavigationToolbar/TurnNavigationToolbar";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { AiNetworkIcon, ArrowDown01Icon, HugeiconsIcon } from "@src/icons";
import { isAgentOrgMemberEmpty } from "@src/util/agentOrg/memberActivity";

export { shouldShowTurnPaginationSpinner } from "@src/components/TurnNavigationToolbar/shouldShowTurnPaginationSpinner";

interface TurnPaginationControlsProps {
  agentName?: string | null;
  /** memberId of the row currently being viewed, used for active state. */
  currentMemberId?: string | null;
  agentOrgMembers?: AgentOrgRunMemberView[];
  agentOrgOverviewPanel?: React.ReactNode;
  agentOrgOverviewOpen: boolean;
  setAgentOrgOverviewOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onAgentOrgMemberSelect?: (member: AgentOrgRunMemberView) => void;
  onAgentOrgRunViewRefresh?: () => Promise<void>;
  turnPaginationEnabled: boolean;
  turnPaginationReady: boolean;
  turnPageListOpen: boolean;
  setTurnPageListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  turnPageSortAscending: boolean;
  setTurnPageSortAscending: React.Dispatch<React.SetStateAction<boolean>>;
  currentTurnPageLabel: string;
  currentTurnPageTimeLabel: string;
  currentPageIndex: number;
  pageCount: number;
  onPreviousTurnPage: () => void;
  onNextTurnPage: () => void;
  onLastTurnPage: () => void;
  /**
   * Optional slot rendered immediately to the right of the round-select
   * trigger, separated by a vertical bar. Subagent panels use this to
   * inject a "toggle turn prompt" info button so it sits with the round
   * selector rather than the replay footer. Hidden when
   * `turnPaginationEnabled` is false (the entire round selector is gone).
   */
  trailingActions?: React.ReactNode;
  /**
   * When true, the chat surface is rendering the Agent Team group chat
   * view instead of the per-member `ChatHistory`. The agent dropdown
   * shows this as a checked first-row option ("Group chat") and the
   * trigger label is replaced by the group label so the user can see
   * the active surface at a glance.
   */
  groupChatViewActive?: boolean;
  /**
   * Toggles the group chat view. When the user picks a member row,
   * the parent should additionally turn the group view off so the
   * usual single-member ChatHistory takes over.
   */
  onGroupChatViewToggle?: (active: boolean) => void;
  /**
   * When false, the "Group chat" option is hidden (e.g. the active
   * session is not an Agent Team run or has no eligible members).
   */
  groupChatViewAvailable?: boolean;
}

const SELECT_TRIGGER_BASE =
  "flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 text-[13px] font-normal text-text-1 transition-colors";
const SELECT_CHEVRON_CLASS = "shrink-0 text-text-3 transition-transform";

const MEMBER_RUNTIME_STATUS_LABEL_KEYS: Record<string, string> = {
  idle: "planner.agentOrgMemberStatus.idle",
  running: "planner.agentOrgMemberStatus.running",
  waiting_for_user: "planner.agentOrgMemberStatus.waitingForUser",
  completed: "planner.agentOrgMemberStatus.completed",
  failed: "planner.agentOrgMemberStatus.failed",
  cancelled: "planner.agentOrgMemberStatus.cancelled",
  user_intervention: "planner.agentOrgMemberStatus.userIntervention",
};

function formatFallbackStatusLabel(status: string): string {
  return status
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// memo: every parent re-render (e.g. each chat-history snapshot or
// turn-page selection) would otherwise re-mount the whole toolbar,
// causing the round selector to visibly flash on prev/next clicks.
// All props are primitives or stable callbacks (useCallback / state
// setters), so the default shallow compare is enough.
const TurnPaginationControls: React.FC<TurnPaginationControlsProps> = memo(
  ({
    agentName,
    currentMemberId = null,
    agentOrgMembers = [],
    agentOrgOverviewPanel,
    agentOrgOverviewOpen,
    setAgentOrgOverviewOpen,
    onAgentOrgMemberSelect,
    onAgentOrgRunViewRefresh,
    turnPaginationEnabled,
    turnPaginationReady,
    turnPageListOpen,
    setTurnPageListOpen,
    turnPageSortAscending,
    setTurnPageSortAscending,
    currentTurnPageLabel,
    currentTurnPageTimeLabel,
    currentPageIndex,
    pageCount,
    onPreviousTurnPage,
    onNextTurnPage,
    onLastTurnPage,
    trailingActions,
    groupChatViewActive = false,
    onGroupChatViewToggle,
    groupChatViewAvailable = false,
  }) => {
    const { t } = useTranslation();
    const switchableMembers = agentOrgMembers.filter(
      (member) => member.sessionRuntime
    );
    const hasGroupChatToggle =
      groupChatViewAvailable && Boolean(onGroupChatViewToggle);
    const canSwitchAgentOrgMember =
      (switchableMembers.length > 1 && Boolean(onAgentOrgMemberSelect)) ||
      hasGroupChatToggle;
    const hasAgentOrgOverview = Boolean(agentOrgOverviewPanel);
    // Resolve by memberId when available (handles members that share a
    // `name`); fall back to name match for legacy callers.
    const currentAgentOrgMember = currentMemberId
      ? agentOrgMembers.find((member) => member.memberId === currentMemberId)
      : agentName
        ? agentOrgMembers.find((member) => member.name === agentName)
        : undefined;
    // Verbatim labels: coordinator → "Coordinator", everyone else →
    // their stored member name. No `agentOrgRoles.*` localisation —
    // role names are product identifiers, not UI copy.
    const groupChatLabel = t("sessions:groupChat.triggerLabel", {
      defaultValue: "Group chat",
    });
    const currentAgentNameLabel = groupChatViewActive
      ? groupChatLabel
      : currentAgentOrgMember?.isCoordinator
        ? "Coordinator"
        : (currentAgentOrgMember?.name ?? agentName ?? null);
    const {
      isOpen: isMemberSwitcherOpen,
      isPositioned: isMemberSwitcherPositioned,
      setIsOpen: setMemberSwitcherOpen,
      close: closeMemberSwitcher,
      triggerRef: memberSwitcherTriggerRef,
      panelRef: memberSwitcherPanelRef,
      panelPosition: memberSwitcherPanelPosition,
    } = useDropdownEngine<HTMLButtonElement>({
      disabled: !canSwitchAgentOrgMember,
      gap: 4,
      placement: "bottom",
      align: "left",
    });

    const agentOrgLeading = (
      <>
        {hasAgentOrgOverview && (
          <>
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              data-agent-org-overview-trigger="true"
              className={
                agentOrgOverviewOpen ? "bg-surface-hover! text-primary-6!" : ""
              }
              onClick={() => {
                closeMemberSwitcher();
                setTurnPageListOpen(false);
                setAgentOrgOverviewOpen((open) => !open);
              }}
              aria-label={t("sessions:planner.agentOrgOverview.title")}
              title={t("sessions:planner.agentOrgOverview.title")}
              icon={
                <HugeiconsIcon
                  icon={AiNetworkIcon}
                  data-icon="network"
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                />
              }
            />
            {agentName && <HeaderSectionSeparator />}
          </>
        )}
        {currentAgentNameLabel && (
          <>
            <button
              ref={memberSwitcherTriggerRef}
              type="button"
              data-testid="agent-org-member-switcher-trigger"
              className={`${SELECT_TRIGGER_BASE} disabled:cursor-default ${
                canSwitchAgentOrgMember
                  ? `cursor-pointer ${SURFACE_TOKENS.hover}`
                  : ""
              } ${isMemberSwitcherOpen ? SURFACE_TOKENS.selected : ""}`}
              disabled={!canSwitchAgentOrgMember}
              onClick={() => {
                if (!canSwitchAgentOrgMember) return;
                setAgentOrgOverviewOpen(false);
                setTurnPageListOpen(false);
                if (!isMemberSwitcherOpen) {
                  void onAgentOrgRunViewRefresh?.();
                }
                setMemberSwitcherOpen(!isMemberSwitcherOpen);
              }}
            >
              <span className="truncate">{currentAgentNameLabel}</span>
              {canSwitchAgentOrgMember && (
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  data-icon="chevron-down"
                  size={DROPDOWN_ITEM.iconSize}
                  className={`${SELECT_CHEVRON_CLASS} ${
                    isMemberSwitcherOpen ? "rotate-180" : ""
                  }`}
                />
              )}
            </button>
            {isMemberSwitcherOpen &&
              isMemberSwitcherPositioned &&
              createPortal(
                <DropdownPanel
                  ref={memberSwitcherPanelRef}
                  className="min-w-[180px]"
                  animated={false}
                  maxHeight="none"
                  style={{
                    position: "fixed",
                    top: memberSwitcherPanelPosition.top,
                    left: memberSwitcherPanelPosition.left,
                  }}
                >
                  <div className={DROPDOWN_CLASSES.optionsContainer}>
                    {hasGroupChatToggle && (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="agent-org-group-chat-toggle"
                          className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} ${
                            groupChatViewActive
                              ? DROPDOWN_CLASSES.itemSelected
                              : ""
                          }`}
                          onClick={() => {
                            onGroupChatViewToggle?.(true);
                            closeMemberSwitcher();
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate text-left">
                            {groupChatLabel}
                          </span>
                        </button>
                        <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                      </>
                    )}
                    {switchableMembers.map((member) => {
                      const isCurrent =
                        !groupChatViewActive &&
                        (currentMemberId
                          ? member.memberId === currentMemberId
                          : member.name === agentName);
                      const runtimeStatus = member.sessionRuntime?.status ?? "";
                      const memberLabel = member.isCoordinator
                        ? "Coordinator"
                        : member.name;
                      const hasNoTasksAndNoInbox =
                        !member.isCoordinator && isAgentOrgMemberEmpty(member);
                      const runtimeStatusLabelKey =
                        MEMBER_RUNTIME_STATUS_LABEL_KEYS[runtimeStatus];
                      const runtimeStatusLabel = hasNoTasksAndNoInbox
                        ? t("sessions:planner.agentOrgMemberStatus.noTasks", {
                            defaultValue: "No tasks",
                          })
                        : runtimeStatus
                          ? runtimeStatusLabelKey
                            ? t(`sessions:${runtimeStatusLabelKey}`)
                            : formatFallbackStatusLabel(runtimeStatus)
                          : "";
                      const isDisabled = hasNoTasksAndNoInbox;
                      return (
                        <button
                          key={member.memberId}
                          type="button"
                          role="menuitem"
                          data-testid={`agent-org-member-switcher-option-${member.memberId}`}
                          disabled={isDisabled}
                          aria-disabled={isDisabled || undefined}
                          className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} ${
                            isCurrent ? DROPDOWN_CLASSES.itemSelected : ""
                          } ${isDisabled ? "cursor-not-allowed opacity-50" : ""}`}
                          onClick={() => {
                            if (isDisabled) return;
                            if (groupChatViewActive) {
                              onGroupChatViewToggle?.(false);
                            }
                            onAgentOrgMemberSelect?.(member);
                            closeMemberSwitcher();
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate text-left">
                            {memberLabel}
                          </span>
                          {runtimeStatusLabel && (
                            <span className="shrink-0 text-[11px] text-text-3">
                              {runtimeStatusLabel}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </DropdownPanel>,
                document.body
              )}
            {agentName && turnPaginationEnabled ? (
              <HeaderSectionSeparator />
            ) : null}
          </>
        )}
      </>
    );

    if (!turnPaginationEnabled) {
      if (!hasAgentOrgOverview && !currentAgentNameLabel) return null;
      return (
        <div
          className={`flex h-10 min-h-10 shrink-0 items-center gap-1.5 px-2 text-xs text-text-3 ${CHAT_PANEL_WIDTH_TOKENS.contentWidth}`}
        >
          {agentOrgLeading}
        </div>
      );
    }

    return (
      <TurnNavigationToolbar
        variant="desktop"
        className={CHAT_PANEL_WIDTH_TOKENS.contentWidth}
        enabled
        ready={turnPaginationReady}
        listOpen={turnPageListOpen}
        onToggleList={() => {
          setAgentOrgOverviewOpen(false);
          closeMemberSwitcher();
          setTurnPageListOpen((open) => !open);
        }}
        sortAscending={turnPageSortAscending}
        onToggleSort={() => setTurnPageSortAscending((ascending) => !ascending)}
        onCloseList={() => setTurnPageListOpen(false)}
        currentLabel={currentTurnPageLabel}
        currentTimeLabel={currentTurnPageTimeLabel}
        currentIndex={currentPageIndex}
        pageCount={pageCount}
        onPrevious={onPreviousTurnPage}
        onNext={onNextTurnPage}
        onLatest={onLastTurnPage}
        leading={agentOrgLeading}
        trailingAfterSelector={trailingActions}
      />
    );
  }
);

TurnPaginationControls.displayName = "TurnPaginationControls";

export default TurnPaginationControls;
