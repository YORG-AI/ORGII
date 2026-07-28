import { ChevronDown, ChevronRight, Terminal } from "lucide-react";
import React, { memo, useCallback, useState } from "react";

import { TerminalOutput } from "@src/components/TerminalDisplay";

import type { TerminalPillData } from "./bubbleParsers";

const TERMINAL_PREVIEW_MAX_HEIGHT = 160;

export const TerminalContextCard: React.FC<{ pill: TerminalPillData }> = memo(
  ({ pill }) => {
    const [isExpanded, setIsExpanded] = useState(true);
    const toggle = useCallback((event: React.MouseEvent) => {
      event.stopPropagation();
      setIsExpanded((prev) => !prev);
    }, []);

    return (
      <div className="overflow-hidden rounded-lg bg-fill-2 text-left">
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        >
          <Terminal size={13} className="shrink-0 text-primary-6" />
          <span className="flex-1 truncate text-[12px] font-medium text-text-1">
            {pill.displayName}
          </span>
          {isExpanded ? (
            <ChevronDown size={11} className="shrink-0 text-text-3" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-text-3" />
          )}
        </button>
        {isExpanded && (
          <div
            className="relative rounded-b-lg bg-bg-3"
            style={{
              boxShadow:
                "inset 0 6px 8px -6px rgba(0,0,0,0.4), inset 0 -6px 8px -6px rgba(0,0,0,0.4)",
            }}
          >
            <TerminalOutput
              output={pill.terminalText}
              maxHeight={TERMINAL_PREVIEW_MAX_HEIGHT}
              showLoading={false}
              className="scrollbar-hide"
            />
          </div>
        )}
      </div>
    );
  }
);
TerminalContextCard.displayName = "TerminalContextCard";
