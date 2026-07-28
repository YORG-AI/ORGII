import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, Toolbox } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";

import Markdown from "@src/components/MarkDown";
import type { InstalledSkill } from "@src/types/extensions";

import { type SkillPillData, resolveSkillFilePath } from "./bubbleParsers";

const SKILL_PREVIEW_MAX_HEIGHT = 160;

export const SkillContextCard: React.FC<{
  pill: SkillPillData;
  installedSkills: InstalledSkill[];
}> = memo(({ pill, installedSkills }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  /** undefined = not yet fetched / loading, null = error/empty, string = content */
  const [content, setContent] = useState<string | undefined | null>(undefined);
  const fetchedRef = React.useRef(false);

  const filePath = useMemo(
    () => resolveSkillFilePath(pill.skillName, installedSkills),
    [pill.skillName, installedSkills]
  );

  useEffect(() => {
    if (!isExpanded || fetchedRef.current) return;
    fetchedRef.current = true;
    invoke<string>("skills_read", { workspacePath: null, name: pill.skillName })
      .then((text) => {
        setContent(text || null);
      })
      .catch(() => {
        setContent(null);
      });
  }, [isExpanded, pill.skillName]);

  const toggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleCardClick = useCallback(() => {
    const path = filePath;
    if (!path) return;
    document.dispatchEvent(
      new CustomEvent("file-pill-click", {
        detail: {
          filePath: path,
          fileName: pill.displayName,
          isFolder: false,
        },
      })
    );
  }, [filePath, pill.displayName]);

  return (
    <div className="overflow-hidden rounded-lg bg-fill-2 text-left">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Toolbox size={13} className="shrink-0 text-primary-6" />
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
          role={filePath ? "button" : undefined}
          tabIndex={filePath ? 0 : undefined}
          onClick={filePath ? handleCardClick : undefined}
          onKeyDown={
            filePath
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") handleCardClick();
                }
              : undefined
          }
          className={`relative rounded-b-lg bg-bg-3 px-3 py-2 ${filePath ? "cursor-pointer" : ""}`}
          style={{
            maxHeight: SKILL_PREVIEW_MAX_HEIGHT,
            overflowY: "auto",
            boxShadow:
              "inset 0 6px 8px -6px rgba(0,0,0,0.4), inset 0 -6px 8px -6px rgba(0,0,0,0.4)",
          }}
        >
          {content === undefined && (
            <span className="text-[11px] text-text-3">Loading…</span>
          )}
          {content !== undefined && content !== null && (
            <div className="pointer-events-none text-[11px] leading-relaxed scrollbar-hide">
              <Markdown
                textContent={content}
                useChatCodeBlock={false}
                enableFileNavigation={false}
                skipPreprocess={false}
                disableCanvasInline={true}
              />
            </div>
          )}
          {content === null && (
            <span className="text-[11px] text-text-3">
              No content available
            </span>
          )}
        </div>
      )}
    </div>
  );
});
SkillContextCard.displayName = "SkillContextCard";
