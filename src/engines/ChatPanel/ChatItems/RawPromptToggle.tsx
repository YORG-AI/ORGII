/**
 * RawPromptToggle
 *
 * Toolbar button + anchored panel that reveals the exact prompt string a user
 * turn handed to the model.
 *
 * The bubble it sits under is a rendering of that prompt, not the prompt: pill
 * tokens are drawn as badges, the auto-expanded reference block is stripped,
 * and external-CLI envelopes are normalized away. When the question is *what
 * the model actually read* — an injected SKILL.md, an expanded file, a paste
 * that silently truncated — the bubble is the wrong artifact to inspect. This
 * panel shows the wire content verbatim, in monospace, with a copy action.
 *
 * `Braces` is deliberate: it is already this app's glyph for "view raw" on the
 * session-level transcript action (`SessionHeaderActionsMenu`), and this is the
 * same idea one turn down.
 */
import { useAtomValue } from "jotai";
import { Braces } from "lucide-react";
import React, { memo, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS,
  ChatBubbleCopyButton,
} from "@src/components/ChatBubble";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { getDropdownPanelStyle } from "@src/hooks/dropdown/dropdownPanelStyle";
import { useDropdownEngine } from "@src/hooks/dropdown/useDropdownEngine";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { toIntlLocaleTag } from "@src/util/data/formatters/date";

import { describeModelLabel } from "./rawPromptModelLabel";

/**
 * Design cap for the panel. `getDropdownPanelStyle` only ever shrinks it, so a
 * tall viewport cannot stretch the panel past the height intended here.
 */
const PANEL_MAX_HEIGHT = 420;

/** Wide enough for an expanded file block without crowding the chat column. */
const PANEL_WIDTH = "min(560px, calc(100vw - 24px))";

interface RawPromptToggleProps {
  /** Wire content for this turn — never the rendered bubble text. */
  rawText: string;
  /** Names the model in the panel header. */
  sessionId: string;
  /**
   * Lifted so the hover-revealed toolbar can stay visible while the panel is
   * open. Ancestor `opacity-0` cannot be undone by a descendant, so the
   * trigger would otherwise vanish out from under its own panel the moment
   * focus moved into the portal (e.g. selecting text).
   */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Panel body. Split out so the session subscription that names the model is
 * mounted only while the panel is open — every user bubble in the history
 * renders the trigger, but at most one panel exists at a time.
 */
const RawPromptPanelBody: React.FC<{ rawText: string; sessionId: string }> = ({
  rawText,
  sessionId,
}) => {
  const { t, i18n } = useTranslation("sessions");
  const session = useAtomValue(sessionByIdAtom(sessionId));

  // The session's model, not a per-turn record: nothing on the user-message
  // event names the model that answered it. Accurate unless the model was
  // switched after this turn ran. `variant` carries the reasoning effort for
  // the ids that encode one, and is empty for the ids that do not.
  const model = describeModelLabel(session?.model);

  const lengthLabel = t("chat.rawPrompt.length", {
    defaultValue: "{{length}} chars",
    length: rawText.length.toLocaleString(
      toIntlLocaleTag(i18n.resolvedLanguage)
    ),
  });

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-2/60 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text-1">
            {t("chat.rawPrompt.title", {
              defaultValue: "Raw prompt sent to AI",
            })}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-text-3">
            {model && (
              <>
                <span className="truncate">{model.name}</span>
                {model.variant && (
                  <span
                    className="shrink-0 rounded bg-fill-2 px-1 text-text-2"
                    data-testid="chat-message-raw-prompt-effort"
                  >
                    {model.variant}
                  </span>
                )}
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="shrink-0">{lengthLabel}</span>
          </div>
        </div>
        <ChatBubbleCopyButton content={rawText} placement="toolbar" />
      </div>
      <pre className="allow-select scrollbar-overlay min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed text-text-1">
        {rawText}
      </pre>
    </>
  );
};

const RawPromptToggleComponent: React.FC<RawPromptToggleProps> = ({
  rawText,
  sessionId,
  onOpenChange,
}) => {
  const { t } = useTranslation("sessions");
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { isOpen, isPositioned, toggle, panelRef, panelPosition } =
    useDropdownEngine<HTMLButtonElement>({
      anchorRef: buttonRef,
      placement: "auto",
      align: "right",
      onOpenChange,
    });

  const panelStyle = useMemo<React.CSSProperties>(
    () => ({
      ...getDropdownPanelStyle(panelPosition, {
        widthMode: "none",
        maxHeightCap: PANEL_MAX_HEIGHT,
      }),
      width: PANEL_WIDTH,
    }),
    [panelPosition]
  );

  const label = t("chat.rawPrompt.view", { defaultValue: "View raw prompt" });

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      toggle();
    },
    [toggle]
  );

  const stopPropagation = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="chat-message-raw-prompt-toggle"
        title={label}
        aria-label={label}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={`${CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS} ${
          isOpen ? "bg-fill-2 text-text-1" : "text-text-3 hover:text-text-1"
        }`}
        onClick={handleClick}
      >
        <Braces size={14} strokeWidth={1.75} />
      </button>

      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            data-testid="chat-message-raw-prompt-panel"
            className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} fixed flex flex-col`}
            style={panelStyle}
            onClick={stopPropagation}
          >
            <RawPromptPanelBody rawText={rawText} sessionId={sessionId} />
          </div>,
          document.body
        )}
    </>
  );
};

const RawPromptToggle = memo(RawPromptToggleComponent);
RawPromptToggle.displayName = "RawPromptToggle";

export default RawPromptToggle;
