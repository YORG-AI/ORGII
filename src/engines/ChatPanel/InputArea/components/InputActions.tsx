/**
 * InputActions Component
 *
 * Send button state machine (priority, highest first):
 *   1. Non-empty input        → Submit (arrow up, active color)
 *      Works even while agent is running. Submit handler routes to the
 *      silent queue so the user never sees a "waiting for current turn"
 *      state; the queue flushes on the next runtime-status falling edge.
 *   2. Working + can stop     → Stop (filled square)
 *   3. Working + cannot stop  → Spinner (disabled)
 *   4. Pending-cancel + empty → Send-looking, but clicking re-fires
 *                                interrupt() so a stuck backend can be
 *                                cancelled again without the button
 *                                locking up.
 *   5. Terminal + can resume  → Retry (orange, CLI sessions only)
 *   6. Otherwise              → Submit (arrow up, inactive color, noop)
 */
import { useAtomValue } from "jotai";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import React, { memo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Message from "@src/components/Message";
import Tooltip from "@src/components/Tooltip";
import { INPUT_AREA_BUTTONS } from "@src/config/inputAreaTokens";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { chatAppearanceAtom } from "@src/store/config/configAtom";

interface InputActionsProps {
  isInputEmpty: boolean;
  isWpGeneWorking: boolean;
  /**
   * True once Stop has been clicked but Rust hasn't acknowledged yet.
   * While this is true, `isWpGeneWorking` is already `false` (for instant
   * visual feedback on the button icon), but we still want clicking the
   * (Send-looking) button on an empty input to re-fire `interrupt()` —
   * otherwise a stuck subagent leaves the user with a useless button.
   */
  isPendingCancel: boolean;
  isHosted: boolean;
  /** Whether stop button is available (cloud or OS Agent) */
  canStopAgent: boolean;
  /** Whether the session supports resume (CLI sessions only) */
  canResume: boolean;
  /** Whether the session is in a terminal failure state (failed/cancelled) */
  isSessionTerminal: boolean;
  onSubmit: () => void;
  onInterrupt: () => Promise<void>;
  onResume: () => Promise<void>;
  tone?: "primary" | "warning";
  submitDisabled?: boolean;
}

const InputActions: React.FC<InputActionsProps> = memo(
  ({
    isInputEmpty,
    isWpGeneWorking,
    isPendingCancel,
    isHosted: _isMarket,
    canStopAgent,
    canResume,
    isSessionTerminal,
    onSubmit,
    onInterrupt,
    onResume,
    tone = "primary",
    submitDisabled = false,
  }) => {
    const { t } = useTranslation();
    const { sendOnEnter } = useAtomValue(chatAppearanceAtom);
    const suppressSubmitClickUntilRef = useRef(0);

    // Non-empty input ALWAYS wins over the working indicator: the user can
    // type a new message while the agent is running, and it will be silently
    // queued. Retry is CLI-only (Rust agents have no resume).
    const showSubmit = !isInputEmpty;
    const showRetry =
      !showSubmit && canResume && isSessionTerminal && !isWpGeneWorking;
    const showStop = !showSubmit && isWpGeneWorking;
    // "Cancel is in flight, input is empty": the icon already reverted to
    // the Send arrow (because `isWpGeneWorking` was gated by
    // `!isPendingCancel` upstream). Keep the click handler wired to
    // interrupt so a stuck backend can be prodded again.
    const reinforceCancel = !showSubmit && !showStop && isPendingCancel;

    const handleClick = async () => {
      if (showSubmit) {
        if (submitDisabled) {
          return;
        }
        if (Date.now() < suppressSubmitClickUntilRef.current) {
          return;
        }
        onSubmit();
        return;
      }
      if (showStop) {
        if (canStopAgent) {
          suppressSubmitClickUntilRef.current = Date.now() + 700;
          void onInterrupt();
        } else {
          Message.info(t("sessions:chat.workspaceIsWorking"));
        }
        return;
      }
      if (reinforceCancel) {
        if (canStopAgent) {
          void onInterrupt();
        }
        return;
      }
      if (showRetry) {
        await onResume();
      }
    };

    const isActive = (showSubmit && !submitDisabled) || showRetry;

    // Hover variants use a brand-shade swap (paint-only) rather than
    // `opacity-80`. See INPUT_AREA_BUTTONS.iconButtonActive for the
    // layer-promotion shake explanation. `transition-colors` keeps the
    // 200ms animation limited to the background swap.
    const baseClass = `flex ${INPUT_AREA_BUTTONS.iconButtonSizeClass} shrink-0 items-center justify-center rounded-full transition-colors duration-200 focus:outline-none`;
    const activeButtonClass =
      tone === "warning"
        ? "cursor-pointer border-none bg-warning-6 text-white hover:bg-warning-5"
        : INPUT_AREA_BUTTONS.iconButtonActive;
    const inactiveButtonClass =
      tone === "warning"
        ? "border-none bg-warning-6 text-white opacity-50"
        : INPUT_AREA_BUTTONS.iconButtonInactive;

    const stateClass = showSubmit
      ? submitDisabled
        ? inactiveButtonClass
        : activeButtonClass
      : showStop
        ? canStopAgent
          ? "cursor-pointer border-none bg-text-2 text-white hover:bg-text-1"
          : "cursor-not-allowed border border-solid border-border-2 bg-transparent text-text-3 opacity-50"
        : showRetry
          ? "cursor-pointer border-none bg-warning-6 text-white hover:bg-warning-5"
          : isActive
            ? activeButtonClass
            : inactiveButtonClass;

    const title = showStop
      ? canStopAgent
        ? t("common:actions.stop")
        : undefined
      : showRetry
        ? t("common:actions.retry")
        : undefined;

    // Button is only disabled for the "working and cannot stop" dead-end.
    const disabled =
      (showStop && !canStopAgent) || (showSubmit && submitDisabled);

    const sendState =
      showStop && !showSubmit
        ? canStopAgent
          ? "stop"
          : "working"
        : showRetry
          ? "retry"
          : "submit";

    // `lineHeight: 0` + `block` SVGs eliminate the inline-flow descender
    // that lucide icons inherit by default. Without this, surrounding
    // toolbar re-layout (hover, tooltip mount, focus ring) nudges the
    // icon by a sub-pixel amount and the ArrowUp visually "shakes".
    const buttonNode = (
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={`${baseClass} ${stateClass} leading-none`}
        style={{ lineHeight: 0 }}
        data-testid="chat-send-button"
        data-state={sendState}
      >
        {showStop && !showSubmit ? (
          canStopAgent ? (
            <Square size={10} fill="currentColor" strokeWidth={0} />
          ) : (
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          )
        ) : showRetry ? (
          <RotateCcw
            size={INPUT_AREA_BUTTONS.iconSize}
            strokeWidth={2}
            className="block text-[#fff]"
          />
        ) : (
          <ArrowUp
            size={INPUT_AREA_BUTTONS.iconSize}
            strokeWidth={2}
            className="block text-[#fff]"
          />
        )}
      </button>
    );

    // Stop / Retry / Working states have no keyboard shortcut — show a plain
    // label so the user always gets feedback on hover, but skip the chip.
    // Send-like states (submit + reinforce-cancel + idle empty Send) all
    // accept ⌘/Ctrl+Enter to dispatch, so the chip is always relevant.
    const isSendLike = sendState === "submit";
    const sendTooltipLabel =
      showSubmit && isWpGeneWorking
        ? t("common:actions.sendMessageQueued")
        : t("common:actions.send");
    const tooltipContent = isSendLike ? (
      <KeyboardShortcutTooltipContent
        label={sendTooltipLabel}
        shortcut={getShortcutKeys("chat_send", {
          chatSendOnEnter: sendOnEnter,
        })}
      />
    ) : (
      title
    );

    if (!tooltipContent) return buttonNode;

    return (
      <Tooltip
        content={tooltipContent}
        position="top-end"
        mouseEnterDelay={200}
        framedPanel={isSendLike}
      >
        {buttonNode}
      </Tooltip>
    );
  }
);

InputActions.displayName = "InputActions";

export default InputActions;
