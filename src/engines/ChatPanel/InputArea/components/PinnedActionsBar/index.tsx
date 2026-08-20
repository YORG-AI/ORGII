/**
 * PinnedActionsBar
 *
 * A horizontal row of pill buttons sitting above the chat input area.
 * Each pill represents a pinned action (skill, tool, or built-in). Clicking
 * a pill dispatches the action into the composer (inserts a skill pill or
 * a slash command). A trailing "..." button opens `PinActionsPanel` to
 * search and manage the pinned set.
 *
 * Design: uses shared secondary buttons so pinned actions match other composer controls.
 */
import { useAtom, useAtomValue } from "jotai";
import { Layout, MoreHorizontal } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import {
  PILL_CONTROL_IDLE_SURFACE_CLASS,
  pillControlStateClass,
} from "@src/components/CompoundPill/config";
import { FileTreeHoverPreview } from "@src/components/FileTreePreview/exports";
import UserActionButton from "@src/engines/ChatPanel/InputArea/components/UserActionButton";
import { useCanvasForTurn } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/useCanvasForTurn";
import { buildBuiltinSlashItems } from "@src/engines/ChatPanel/hooks/useInputArea/builtinSlashItems";
import { useSlashItemsCache } from "@src/engines/ChatPanel/hooks/useInputArea/useSlashItemsCache";
import { EditorTabService } from "@src/services/workStation/EditorTabService";
import {
  type PinnedAction,
  pinnedActionsAtom,
} from "@src/store/session/pinnedActionsAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import { mainPaneTabsAtom } from "@src/store/workstation/tabs";
import {
  createCanvasPreviewTab,
  getCanvasPreviewTabId,
} from "@src/store/workstation/tabs/factories/canvasPreview";
import type { SlashItem } from "@src/types/extensions";
import { SLASH_ACTIONS } from "@src/types/extensions";
import { isCliSession } from "@src/util/session/sessionDispatch";

import {
  buildMcpToolCommand,
  insertAtomicSlashActionPill,
} from "../SlashCommandPortal/slashItemUtils";
import PinActionsPanel, { actionKey } from "./PinActionsPanel";

const SETUP_REPO_SLASH_ITEM: SlashItem = {
  name: SLASH_ACTIONS.SETUP_REPO,
  description: "Auto-detect the repo and launch a one-click setup session",
  category: "action",
  source: "builtin",
  acceptsArgs: false,
};

// ── sub-components ────────────────────────────────────────────────────────────

interface ActionPillProps {
  action: PinnedAction;
  onClick: (action: PinnedAction, e?: React.MouseEvent) => void;
  /**
   * Display label override. Built-ins whose raw name would read ambiguously
   * next to sibling controls pass a localized label ("canvas" pinned next to
   * the "Canvas" preview-reopen button → "New Canvas").
   */
  label?: string;
  /** Forward a ref onto the underlying button. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

const ActionPill: React.FC<ActionPillProps> = memo(
  ({ action, onClick, label, buttonRef }) => {
    const displayLabel = label ?? action.name;
    const button = (
      <Button
        ref={buttonRef}
        variant="secondary"
        size="small"
        shape="round"
        title={displayLabel}
        onClick={(event) => onClick(action, event)}
        className={`max-w-180 shrink-0 select-none ${PILL_CONTROL_IDLE_SURFACE_CLASS}`}
      >
        {displayLabel}
      </Button>
    );

    if (action.category !== "skill" || !action.skillPath) return button;

    return (
      <FileTreeHoverPreview
        path={action.skillPath}
        itemType="file"
        as="div"
        display="inline-block"
        className="shrink-0"
      >
        {button}
      </FileTreeHoverPreview>
    );
  }
);

ActionPill.displayName = "ActionPill";

// ── main component ────────────────────────────────────────────────────────────

export interface PinnedActionsBarProps {
  /** Ref to the composer, used to insert content when a pill is clicked. */
  composerInputRef: React.RefObject<ComposerInputRef | null>;
  /**
   * Active session ID — when provided, a Canvas pill appears whenever the
   * session has a live canvas payload and the canvas tab is not already open.
   */
  sessionId?: string | null;
  workspacePaths?: string[];
  leadingContent?: React.ReactNode;
  trailingContent?: React.ReactNode;
  manageButtonPlacement?: "after-actions" | "after-leading" | "before-actions";
  managePanelAlign?: "left" | "right";
}

const PinnedActionsBar: React.FC<PinnedActionsBarProps> = memo(
  ({
    composerInputRef,
    sessionId,
    workspacePaths,
    leadingContent,
    trailingContent,
    manageButtonPlacement = "after-actions",
    managePanelAlign = "right",
  }) => {
    const { t } = useTranslation("sessions");
    const [pinnedActions, setPinnedActions] = useAtom(pinnedActionsAtom);
    const workspaceFolders = useAtomValue(workspaceFoldersAtom);
    const effectiveWorkspacePaths = useMemo(() => {
      if (workspacePaths) return workspacePaths;
      return workspaceFolders
        .map((folder) => folder.path.replace(/\/+$/, ""))
        .filter(Boolean);
    }, [workspaceFolders, workspacePaths]);
    const builtinSlashItems = useMemo(
      () => [
        ...buildBuiltinSlashItems({
          canvasDescription: t("input.canvasCommandDescription"),
          compactDescription: t("input.compactCommandDescription"),
          // CLI agents have no render_inline_canvas tool — don't offer
          // pinning an action whose projection would have to no-op there.
          includeCanvas: !(sessionId && isCliSession(sessionId)),
        }),
        SETUP_REPO_SLASH_ITEM,
      ],
      [t, sessionId]
    );

    // ── Canvas pill ───────────────────────────────────────────────────────────

    const { snapshot: canvasForTurn, clearCanvas } =
      useCanvasForTurn(sessionId);
    const mainPaneTabs = useAtomValue(mainPaneTabsAtom);

    const showCanvasPill = canvasForTurn.isDismissed;

    const isCanvasTabOpen = Boolean(
      sessionId &&
      mainPaneTabs.some((tab) => tab.id === getCanvasPreviewTabId(sessionId))
    );

    const handleOpenCanvas = useCallback(() => {
      if (!sessionId) return;
      const tab = createCanvasPreviewTab(sessionId);
      EditorTabService.openTab(tab);
    }, [sessionId]);

    const handleClearCanvas = useCallback(() => {
      clearCanvas();
    }, [clearCanvas]);

    // ── Built-in "Setup Repo" action ──────────────────────────────────────────

    const handleSetupRepo = useCallback(() => {
      if (!composerInputRef.current) return;
      composerInputRef.current.insertFilePill(
        "/setup-repo",
        false,
        "skill",
        "setup-repo"
      );
      composerInputRef.current.focus();
    }, [composerInputRef]);

    // ── Available items (shared cache) ────────────────────────────────────────

    const {
      filteredItems: availableItems,
      loading: loadingItems,
      fetchFresh,
    } = useSlashItemsCache({
      builtinItems: builtinSlashItems,
      workspacePaths: effectiveWorkspacePaths,
    });

    const skillPathByName = useMemo(() => {
      const map = new Map<string, string>();
      for (const item of availableItems) {
        if (item.category === "skill" && item.skillName && item.skillPath) {
          map.set(item.skillName, item.skillPath);
          map.set(item.name, item.skillPath);
        }
      }
      return map;
    }, [availableItems]);

    // Resolve pinned skill paths lazily: only scan when a pinned skill is
    // missing its `skillPath` (needed for the hover preview). Pinned actions
    // that already carry a path — the common case — never trigger a scan, so
    // mounting the input stays free. The scan itself is bounded/coalesced by
    // the shared scanner, and the full "…" panel list still loads on open.
    const unresolvedPinnedSkillsKey = useMemo(
      () =>
        pinnedActions
          .filter((action) => action.category === "skill" && !action.skillPath)
          .map((action) => action.skillName ?? action.name)
          .sort()
          .join("\0"),
      [pinnedActions]
    );

    useEffect(() => {
      if (!unresolvedPinnedSkillsKey) return;
      void fetchFresh();
    }, [unresolvedPinnedSkillsKey, fetchFresh]);

    // ── "..." panel state ─────────────────────────────────────────────────────

    const [panelOpen, setPanelOpen] = useState(false);
    const moreButtonRef = useRef<HTMLButtonElement>(null);

    const handleOpenPanel = useCallback(() => {
      // Explicit user action → get a fresh list (still coalesced).
      void fetchFresh({ force: true });
      setPanelOpen((prev) => !prev);
    }, [fetchFresh]);

    const handleClosePanel = useCallback(() => {
      setPanelOpen(false);
    }, []);

    const hasPinnedActions = pinnedActions.length > 0;
    const resolvedPinnedActions = useMemo(
      () =>
        pinnedActions.map((action) => {
          if (action.category !== "skill" || action.skillPath) return action;
          const skillPath = skillPathByName.get(
            action.skillName ?? action.name
          );
          return skillPath ? { ...action, skillPath } : action;
        }),
      [pinnedActions, skillPathByName]
    );
    const showCanvasAction = showCanvasPill && !isCanvasTabOpen;
    const hasActionPills = showCanvasAction || hasPinnedActions;
    const hasTrailingContent = Boolean(trailingContent);
    const showTrailingSeparator = hasActionPills || hasTrailingContent;

    // ── Pin / unpin ───────────────────────────────────────────────────────────

    const handleTogglePin = useCallback(
      (action: PinnedAction) => {
        setPinnedActions((prev) => {
          const key = actionKey(action);
          const exists = prev.some((a) => actionKey(a) === key);
          return exists
            ? prev.filter((a) => actionKey(a) !== key)
            : [...prev, action];
        });
      },
      [setPinnedActions]
    );

    const handleUnpinAll = useCallback(() => {
      setPinnedActions([]);
    }, [setPinnedActions]);

    // ── Pill click → dispatch ─────────────────────────────────────────────────

    const handlePillClick = useCallback(
      (action: PinnedAction, _e?: React.MouseEvent) => {
        if (action.category === "action") {
          if (action.name === SLASH_ACTIONS.SETUP_REPO) {
            handleSetupRepo();
            return;
          }
          if (!composerInputRef.current) return;
          // Every remaining built-in action (canvas, compact) is an atomic
          // composer token; a stale pin with an unknown name is a no-op.
          insertAtomicSlashActionPill(composerInputRef.current, action.name);
          return;
        }

        if (!composerInputRef.current) return;

        if (action.category === "skill") {
          const skillToken = `/${action.skillName ?? action.name}`;
          composerInputRef.current.insertFilePill(
            skillToken,
            false,
            "skill",
            action.name
          );
          composerInputRef.current.focus();
          return;
        }

        if (action.category === "tool" && action.serverName) {
          composerInputRef.current
            .getEditor()
            ?.chain()
            .focus()
            .insertContent(buildMcpToolCommand(action.serverName, action.name))
            .run();
          return;
        }

        composerInputRef.current
          .getEditor()
          ?.chain()
          .focus()
          .insertContent(`/${action.name} `)
          .run();
      },
      [composerInputRef, handleSetupRepo]
    );

    const manageButton = (
      <Button
        ref={moreButtonRef}
        variant="secondary"
        appearance="outline"
        size="small"
        shape="round"
        icon={<MoreHorizontal size={14} strokeWidth={1.75} />}
        iconOnly
        title={t("input.pinnedActions.manage")}
        aria-label={t("input.pinnedActions.manage")}
        onClick={handleOpenPanel}
        className={`shrink-0 ${pillControlStateClass(panelOpen)}`}
      />
    );

    const actionPills = (
      <>
        {showCanvasAction && (
          <div className="shrink-0">
            <UserActionButton
              leftIcon={<Layout size={12} strokeWidth={1.75} />}
              title="Canvas"
              onClick={handleOpenCanvas}
              onClose={handleClearCanvas}
            />
          </div>
        )}

        {resolvedPinnedActions.map((action) => (
          <ActionPill
            key={actionKey(action)}
            action={action}
            // The canvas CREATION action would otherwise render "canvas"
            // right next to the pre-existing "Canvas" preview-reopen button.
            label={
              action.category === "action" &&
              action.name === SLASH_ACTIONS.CANVAS
                ? t("input.newCanvasAction", "New Canvas")
                : undefined
            }
            onClick={handlePillClick}
          />
        ))}
      </>
    );

    return (
      <div className="relative flex min-w-0 flex-1 items-center gap-1">
        {manageButtonPlacement === "before-actions" ? (
          <>
            <div className="flex shrink-0 items-center gap-1">
              {leadingContent}
              {trailingContent}
            </div>
            <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-2" />
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 scrollbar-hide">
              {manageButton}
              {actionPills}
            </div>
          </>
        ) : manageButtonPlacement === "after-leading" ? (
          <>
            <div className="flex shrink-0 items-center gap-1">
              {leadingContent}
              {manageButton}
            </div>
            {showTrailingSeparator && (
              <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-2" />
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 scrollbar-hide">
              {trailingContent}
              {actionPills}
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 scrollbar-hide">
              {leadingContent}
              {actionPills}
            </div>
            {showTrailingSeparator && (
              <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-2" />
            )}
            {trailingContent}
            {manageButton}
          </>
        )}

        <PinActionsPanel
          visible={panelOpen}
          availableItems={availableItems}
          pinnedActions={pinnedActions}
          onTogglePin={handleTogglePin}
          onInsert={handlePillClick}
          onUnpinAll={handleUnpinAll}
          onClose={handleClosePanel}
          loading={loadingItems}
          triggerRef={moreButtonRef}
          align={managePanelAlign}
        />
      </div>
    );
  }
);

PinnedActionsBar.displayName = "PinnedActionsBar";

export default PinnedActionsBar;
