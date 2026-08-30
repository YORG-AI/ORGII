/**
 * Read-only reference primitives for rendered user messages.
 *
 * Persisted composer pills are a wire format, not a presentation contract.
 * References render as ordinary links; only explicit member mentions retain
 * pill treatment. Session references are lifted into cards before this layer.
 */
import React, { memo, useCallback } from "react";

import BasePill from "@src/components/ComposerInput/BasePill";
import {
  isSafePostedReferenceHref,
  resolvePostedReferenceHref,
} from "@src/components/ComposerInput/postedReferenceHref";
import { PILL_SIZE } from "@src/config/pillTokens";
import { AtIcon, HugeiconsIcon } from "@src/icons";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { type MentionSegment, type PillSegment } from "./userMessageSegments";

const ICON_PROPS = { size: PILL_SIZE.iconSize, strokeWidth: 1.75 } as const;

export const InlineReferenceLink: React.FC<{ segment: PillSegment }> = memo(
  ({ segment }) => {
    const href = resolvePostedReferenceHref(
      segment.path,
      segment.pillType,
      segment.terminalText
    );
    const isWebReference = /^https?:\/\//iu.test(href);
    const isFileReference =
      segment.pillType === "file" || segment.pillType === "folder";
    const handleClick = useCallback(
      (e: React.SyntheticEvent) => {
        e.stopPropagation();
        e.preventDefault();

        if (isWebReference) {
          void openExternalLink(href);
          return;
        }

        if (segment.pillType === "terminal") {
          let sessionId: string;
          if (segment.path.startsWith("terminal://")) {
            const parts = segment.path.replace("terminal://", "").split("/");
            sessionId = parts[0];
          } else {
            sessionId = segment.path;
          }

          const terminalText =
            segment.terminalText ??
            window.__orgiiTerminalPillTexts?.[segment.path] ??
            undefined;

          document.dispatchEvent(
            new CustomEvent("terminal-pill-click", {
              detail: {
                sessionId,
                fileName: segment.displayName,
                terminalText,
              },
            })
          );
          return;
        }

        if (
          segment.pillType === "paste" ||
          segment.pillType === "dom-component"
        ) {
          // Route to the dedicated DomComponentPreview tab (Raw / Preview viewer).
          const pasteText =
            segment.terminalText ??
            window.__orgiiTerminalPillTexts?.[segment.path] ??
            "";
          document.dispatchEvent(
            new CustomEvent("dom-component-preview-click", {
              detail: {
                pasteId: segment.path,
                fileName: segment.displayName,
                jsonText: pasteText,
              },
            })
          );
          return;
        }

        if (isFileReference) {
          document.dispatchEvent(
            new CustomEvent("file-pill-click", {
              detail: {
                filePath: segment.path,
                fileName: segment.displayName,
                isFolder: segment.pillType === "folder",
              },
            })
          );
        }
      },
      [href, isFileReference, isWebReference, segment]
    );

    return isSafePostedReferenceHref(href) ? (
      <a
        href={href}
        className="text-primary-6 underline-offset-2 hover:underline focus-visible:underline active:underline"
        title={href}
        onClick={handleClick}
      >
        {segment.displayName}
      </a>
    ) : (
      <span>{segment.displayName}</span>
    );
  }
);
InlineReferenceLink.displayName = "InlineReferenceLink";

export const MentionPill: React.FC<{ segment: MentionSegment }> = memo(
  function MentionPill({ segment }) {
    return (
      <BasePill
        variant="editor"
        iconNode={
          <HugeiconsIcon icon={AtIcon} data-icon="at-sign" {...ICON_PROPS} />
        }
        style={{
          position: "relative",
          zIndex: 1,
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
        title={segment.displayName}
      >
        <span>{segment.displayName}</span>
      </BasePill>
    );
  }
);
