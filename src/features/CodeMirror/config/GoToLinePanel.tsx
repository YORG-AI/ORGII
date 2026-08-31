import { EditorView, Panel } from "@codemirror/view";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@src/components/SearchInput";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import { Cancel01Icon, HashtagIcon, HugeiconsIcon } from "@src/icons";

interface GoToLinePanelProps {
  view: EditorView;
  onClose: () => void;
}

const GoToLinePanel: React.FC<GoToLinePanelProps> = ({ view, onClose }) => {
  const { t } = useTranslation();
  const [lineValue, setLineValue] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const lineCount = view.state.doc.lines;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleGoToLine = useCallback(() => {
    const lineNumber = Number.parseInt(lineValue, 10);
    if (!Number.isFinite(lineNumber)) {
      return;
    }

    const targetLine = Math.max(1, Math.min(lineNumber, view.state.doc.lines));
    const line = view.state.doc.line(targetLine);
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    onClose();
  }, [lineValue, onClose, view]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div
      className="flex w-full border-b border-border-2 shadow-sm"
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center justify-center self-center px-3 text-text-3">
        <HugeiconsIcon
          icon={HashtagIcon}
          data-icon="hash"
          size={HEADER_ICON_SIZE.sm}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1.5">
        <div className="flex items-center gap-2">
          <SearchInput
            variant="sidebar"
            value={lineValue}
            onChange={setLineValue}
            placeholder={t(
              "selectors.editorSpotlight.modes.goToLine.placeholder"
            )}
            inputRef={inputRef}
            inputBoxClassName="flex-none w-[320px]"
            onSubmit={handleGoToLine}
            showClearButton
            hideChevron
          />
          <span className="shrink-0 whitespace-nowrap text-[12px] text-text-3">
            1 - {lineCount}
          </span>
        </div>
      </div>

      <div className="flex items-start py-1.5 pr-3">
        <div className="flex h-7 items-center">
          <button
            type="button"
            onClick={onClose}
            className={HEADER_BUTTON.action}
            title={t("tooltips.closeEsc")}
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              data-icon="x"
              size={HEADER_ICON_SIZE.sm}
            />
          </button>
        </div>
      </div>
    </div>
  );
};

export function createGoToLinePanel(
  view: EditorView,
  onClose: () => void
): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-goto-line-panel-wrapper";

  const root = createRoot(dom);
  root.render(<GoToLinePanel view={view} onClose={onClose} />);

  return {
    dom,
    top: true,
    destroy: () => root.unmount(),
  };
}
