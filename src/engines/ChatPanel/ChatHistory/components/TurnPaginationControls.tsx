/**
 * TurnPaginationControls
 *
 * Top-of-history toolbar that hosts the Agent Team member label, round
 * selector, current time-range label, and previous / next / last-round
 * buttons.
 */
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  ClockArrowDown,
  ClockArrowUp,
  Loader2,
  Network,
  X,
} from "lucide-react";
import React, { memo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import SessionViewersIndicator from "@src/features/Org2Cloud/SessionViewersIndicator";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { WorkstationHeaderSectionSeparator } from "@src/modules/WorkStation/shared";

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

    return (
      <div
        className={`flex h-10 min-h-10 flex-shrink-0 items-center justify-between gap-2 px-2 text-xs text-text-3 ${DETAIL_PANEL_TOKENS.contentWidth}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {hasAgentOrgOverview && (
            <>
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                data-agent-org-overview-trigger="true"
                className={
                  agentOrgOverviewOpen
                    ? "!bg-surface-hover !text-primary-6"
                    : ""
                }
                onClick={() => {
                  closeMemberSwitcher();
                  setTurnPageListOpen(false);
                  setAgentOrgOverviewOpen((open) => !open);
                }}
                aria-label={t("sessions:planner.agentOrgOverview.title")}
                title={t("sessions:planner.agentOrgOverview.title")}
                icon={
                  <Network size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                }
              />
              {agentName && <WorkstationHeaderSectionSeparator />}
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
                  <ChevronDown
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
                  <div
                    ref={memberSwitcherPanelRef}
                    className={`${DROPDOWN_CLASSES.panel} min-w-[180px]`}
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
                          <div className="my-1 h-px bg-border-1" />
                        </>
                      )}
                      {switchableMembers.map((member) => {
                        const isCurrent =
                          !groupChatViewActive &&
                          (currentMemberId
                            ? member.memberId === currentMemberId
                            : member.name === agentName);
                        const runtimeStatus =
                          member.sessionRuntime?.status ?? "";
                        // Verbatim labels — coordinator gets the canonical
                        // English "Coordinator", everyone else shows the
                        // stored member name. No role localisation.
                        const memberLabel = member.isCoordinator
                          ? "Coordinator"
                          : member.name;
                        const hasNoTasksAndNoInbox =
                          !member.isCoordinator &&
                          member.activeTaskCount === 0 &&
                          member.pendingTaskCount === 0 &&
                          member.inProgressTaskCount === 0 &&
                          member.completedTaskCount === 0 &&
                          member.inboxActivityCount === 0;
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
                        // Members with no tasks or inbox activity cannot be
                        // switched to — opening their session would render a
                        // chat panel with no events and a "session may not
                        // have loaded" reload prompt. Coordinator is always
                        // selectable (the parent session, never empty).
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
                  </div>,
                  document.body
                )}
            </>
          )}
          {turnPaginationEnabled && (
            <>
              {agentName && <WorkstationHeaderSectionSeparator />}
              <div className="relative min-w-0">
                <button
                  type="button"
                  data-testid="turn-pagination-current-round"
                  className={`${SELECT_TRIGGER_BASE} cursor-pointer ${SURFACE_TOKENS.hover} disabled:cursor-not-allowed disabled:opacity-50 ${
                    turnPageListOpen ? SURFACE_TOKENS.selected : ""
                  }`}
                  disabled={!turnPaginationReady}
                  onClick={() => {
                    if (!turnPaginationReady) return;
                    setAgentOrgOverviewOpen(false);
                    closeMemberSwitcher();
                    setTurnPageListOpen((open) => !open);
                  }}
                >
                  <span className="truncate">{currentTurnPageLabel}</span>
                  {!turnPaginationReady ? (
                    <Loader2
                      size={DROPDOWN_ITEM.iconSize}
                      className="shrink-0 animate-spin text-text-3"
                    />
                  ) : (
                    <ChevronDown
                      size={DROPDOWN_ITEM.iconSize}
                      className={`${SELECT_CHEVRON_CLASS} ${
                        turnPageListOpen ? "rotate-180" : ""
                      }`}
                    />
                  )}
                </button>
              </div>
              {trailingActions && (
                <>
                  <WorkstationHeaderSectionSeparator />
                  {trailingActions}
                </>
              )}
            </>
          )}
          <SessionViewersIndicator />
        </div>
        {turnPaginationEnabled && (
          <div className="flex shrink-0 items-center gap-1.5">
            {!turnPageListOpen && currentTurnPageTimeLabel && (
              <span className="whitespace-nowrap px-1 text-[13px] tabular-nums text-text-3">
                {currentTurnPageTimeLabel}
              </span>
            )}
            <div className="flex shrink-0 items-center gap-px">
              {turnPageListOpen ? (
                <>
                  <Tooltip
                    content={
                      <KeyboardShortcutTooltipContent
                        label={t("common:actions.sort")}
                      />
                    }
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
                        onClick={() =>
                          setTurnPageSortAscending((ascending) => !ascending)
                        }
                        aria-label={t("common:actions.sort")}
                        icon={
                          turnPageSortAscending ? (
                            <ClockArrowDown
                              size={DROPDOWN_ITEM.iconSize}
                              strokeWidth={1.75}
                            />
                          ) : (
                            <ClockArrowUp
                              size={DROPDOWN_ITEM.iconSize}
                              strokeWidth={1.75}
                            />
                          )
                        }
                      />
                    </span>
                  </Tooltip>
                  <Tooltip
                    content={
                      <KeyboardShortcutTooltipContent
                        label={t("common:actions.close")}
                      />
                    }
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
                        onClick={() => setTurnPageListOpen(false)}
                        aria-label={t("common:actions.close")}
                        icon={
                          <X size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
                        }
                      />
                    </span>
                  </Tooltip>
                </>
              ) : (
                <>
                  <Tooltip
                    content={
                      <KeyboardShortcutTooltipContent
                        label={t("common:pagination.previousRound")}
                      />
                    }
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
                        data-testid="turn-pagination-previous-round"
                        onClick={onPreviousTurnPage}
                        disabled={!turnPaginationReady || currentPageIndex <= 0}
                        aria-label={t("common:pagination.previousRound")}
                        icon={
                          <ChevronLeft
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={1.75}
                          />
                        }
                      />
                    </span>
                  </Tooltip>
                  <Tooltip
                    content={
                      <KeyboardShortcutTooltipContent
                        label={t("common:pagination.nextRound")}
                      />
                    }
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
                        data-testid="turn-pagination-next-round"
                        onClick={onNextTurnPage}
                        disabled={
                          !turnPaginationReady ||
                          currentPageIndex >= pageCount - 1
                        }
                        aria-label={t("common:pagination.nextRound")}
                        icon={
                          <ChevronRight
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={1.75}
                          />
                        }
                      />
                    </span>
                  </Tooltip>
                  <Tooltip
                    content={
                      <KeyboardShortcutTooltipContent
                        label={t("common:pagination.latestRound")}
                      />
                    }
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
                        data-testid="turn-pagination-last-round"
                        onClick={onLastTurnPage}
                        disabled={
                          !turnPaginationReady ||
                          currentPageIndex >= pageCount - 1
                        }
                        aria-label={t("common:pagination.latestRound")}
                        icon={
                          <ChevronsRight
                            size={18}
                            strokeWidth={1.75}
                            className="translate-y-[0.5px]"
                          />
                        }
                      />
                    </span>
                  </Tooltip>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
);

TurnPaginationControls.displayName = "TurnPaginationControls";

export default TurnPaginationControls;
