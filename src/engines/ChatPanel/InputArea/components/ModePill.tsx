/**
 * ModePill Component
 *
 * Compact mode selector pill for ORGII `AgentExecMode` sessions.
 *
 * Three usage modes — they map to different sources of truth:
 *  1. Controlled (`value` prop) — caller owns the value, used for the
 *     SessionCreator preview where the user is configuring a session
 *     that doesn't exist yet.
 *  2. SessionCreator default (`forceVisible`, no sessionId) — reads /
 *     writes `creatorDefaultExecModeAtom` (the localStorage-backed
 *     default for *new* sessions).
 *  3. In-session (sessionId present, not controlled, not forceVisible)
 *     — reads / writes the per-session row via `useSessionExecModeField`.
 *     Falls back to the creator default *only* when the session has
 *     never been patched (`agentExecMode === undefined`), then promotes
 *     the next user click into a real `session_patch` so subsequent
 *     reads come from the row instead of the global atom.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import React, { memo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import SelectorPill from "@src/components/SelectorPill";
import {
  AGENT_EXEC_MODES,
  type AgentExecMode,
  COMPOSER_MODES,
  type ComposerModeEntry,
  DEFAULT_AGENT_EXEC_MODE,
  PRODUCT_MODE_PROJECT,
  execModeForComposerSelection,
  normalizeAgentExecMode,
} from "@src/config/sessionCreatorConfig";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  useSessionExecModeField,
  useSessionProductModeField,
} from "@src/hooks/session/useSessionPatch";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import {
  isAgentSession,
  isCliSession,
  isWingmanSession,
} from "@src/util/session/sessionDispatch";

export interface ModePillProps {
  /** Show pill regardless of active session (for session creator) */
  forceVisible?: boolean;
  /** Called after mode changes — use to sync external state (e.g. advancedConfig.flow) */
  onModeChange?: (mode: AgentExecMode) => void;
  /** Controlled mode value — when provided, bypasses both atoms */
  value?: AgentExecMode;
  /** Dropdown placement direction */
  placement?: "top" | "bottom";
  /** Hide the pill when the selected mode is the default Build mode. */
  hideWhenDefault?: boolean;
  /** Reset to Build when clicking a visible non-default pill. */
  resetToDefaultOnClick?: boolean;
}

const ModePill: React.FC<ModePillProps> = memo(
  ({
    forceVisible = false,
    onModeChange,
    value,
    placement = "top",
    hideWhenDefault = false,
    resetToDefaultOnClick = false,
  }) => {
    const { t } = useTranslation("sessions");
    const { sessionId } = useSessionId();

    const isControlled = value !== undefined;
    // In-session reads use the session row; creator-default reads use
    // the localStorage atom. We always subscribe to *both* so the
    // hooks order is stable across renders, then pick the right value
    // below based on the current usage mode.
    const creatorDefault = useAtomValue(creatorDefaultExecModeAtom);
    const setCreatorDefault = useSetAtom(creatorDefaultExecModeAtom);
    const { agentExecMode: sessionMode, setMode: setSessionMode } =
      useSessionExecModeField(sessionId ?? "");
    const { productMode, setProductMode } = useSessionProductModeField(
      sessionId ?? ""
    );

    const isInSessionMode =
      !isControlled && !forceVisible && Boolean(sessionId);
    const mode: AgentExecMode = isControlled
      ? (value as AgentExecMode)
      : isInSessionMode
        ? (normalizeAgentExecMode(sessionMode) ?? creatorDefault)
        : creatorDefault;

    // Product-mode axis (orgtrack/v1 §5.2): when the session is in
    // Project mode the pill displays Project regardless of the derived
    // exec mode. Only agent sessions carry a product mode, and the
    // creator/controlled variants stay exec-only until the Project
    // bootstrap flow lands there.
    const isProjectSession =
      isInSessionMode && productMode === PRODUCT_MODE_PROJECT;
    const pickerModes: ComposerModeEntry[] = isInSessionMode
      ? COMPOSER_MODES
      : AGENT_EXEC_MODES;

    const currentOption = isProjectSession
      ? (COMPOSER_MODES.find((opt) => opt.id === PRODUCT_MODE_PROJECT) ??
        AGENT_EXEC_MODES[0])
      : (AGENT_EXEC_MODES.find((opt) => opt.id === mode) ??
        AGENT_EXEC_MODES[0]);
    const CurrentIcon = currentOption.icon;
    const currentLabel = t(currentOption.i18nKey, {
      defaultValue: currentOption.name,
    });
    const toneClassName = isProjectSession
      ? "mode-pill-tone-plan"
      : mode === "plan"
        ? "mode-pill-tone-plan"
        : mode === "ask"
          ? "mode-pill-tone-ask"
          : "";

    const {
      isOpen,
      isPositioned,
      toggle,
      close,
      triggerRef,
      panelRef,
      panelPosition,
    } = useDropdownEngine<HTMLButtonElement>({
      gap: 6,
      align: "left",
      placement,
    });

    const setModeValue = useCallback(
      (selected: ComposerModeEntry["id"]) => {
        const derivedExecMode = execModeForComposerSelection(selected);
        if (!isControlled) {
          if (isInSessionMode) {
            // §5.2: the selector writes the PRODUCT mode; the runtime
            // exec mode is derived (project → build, identity
            // otherwise). Both patches are fire-and-forget — the hooks
            // do optimistic store writes before awaiting the RPC, so
            // the pill repaints with the new value on the same frame.
            // Errors are surfaced via the hooks' own state.
            void setProductMode(selected);
            void setSessionMode(derivedExecMode);
          } else {
            setCreatorDefault(derivedExecMode);
          }
        }
        onModeChange?.(derivedExecMode);
      },
      [
        isControlled,
        isInSessionMode,
        setSessionMode,
        setProductMode,
        setCreatorDefault,
        onModeChange,
      ]
    );

    const handleSelect = useCallback(
      (selected: ComposerModeEntry["id"]) => {
        setModeValue(selected);
        close();
      },
      [setModeValue, close]
    );

    const handleTriggerClick = useCallback(() => {
      if (
        resetToDefaultOnClick &&
        !isProjectSession &&
        mode !== DEFAULT_AGENT_EXEC_MODE
      ) {
        setModeValue(DEFAULT_AGENT_EXEC_MODE);
        close();
        return;
      }
      toggle();
    }, [
      resetToDefaultOnClick,
      isProjectSession,
      mode,
      setModeValue,
      close,
      toggle,
    ]);

    const isVisible =
      forceVisible ||
      (sessionId && (isAgentSession(sessionId) || isCliSession(sessionId)));
    if (
      !isVisible ||
      (sessionId && isWingmanSession(sessionId)) ||
      (hideWhenDefault && !isProjectSession && mode === DEFAULT_AGENT_EXEC_MODE)
    ) {
      return null;
    }

    return (
      <div className="relative">
        <SelectorPill
          ref={triggerRef}
          icon={
            <CurrentIcon
              size={14}
              strokeWidth={1.75}
              className={toneClassName || "text-text-1"}
            />
          }
          label={currentLabel}
          tooltip={t("creator.switchMode")}
          tooltipFramed
          tooltipPosition="top"
          active={isOpen}
          dataTestId="agent-exec-mode-pill"
          onClick={handleTriggerClick}
          hoverIcon={
            resetToDefaultOnClick && mode !== DEFAULT_AGENT_EXEC_MODE ? (
              <X size={14} strokeWidth={1.75} />
            ) : undefined
          }
          className={`h-[28px] text-[13px] ${toneClassName}`}
          size="sm"
        />

        {isOpen &&
          isPositioned &&
          createPortal(
            <DropdownPanel
              ref={panelRef}
              className={`fixed ${DROPDOWN_WIDTHS.menuClass}`}
              style={{
                ...(panelPosition.top !== undefined
                  ? { top: panelPosition.top }
                  : { bottom: panelPosition.bottom }),
                left: panelPosition.left,
              }}
            >
              <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
                {pickerModes.map((option) => {
                  const Icon = option.icon;
                  const isSelected = isProjectSession
                    ? option.id === PRODUCT_MODE_PROJECT
                    : mode === option.id;
                  return (
                    <DropdownItem
                      key={option.id}
                      icon={
                        <Icon
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={1.75}
                        />
                      }
                      selected={isSelected}
                      showCheckmark
                      dataTestId={`agent-exec-mode-option-${option.id}`}
                      onClick={() => handleSelect(option.id)}
                    >
                      {t(option.i18nKey, { defaultValue: option.name })}
                    </DropdownItem>
                  );
                })}
              </div>
            </DropdownPanel>,
            document.body
          )}
      </div>
    );
  }
);

ModePill.displayName = "ModePill";

export default ModePill;
