/**
 * SubagentBlock — helper functions and prompt preview sub-component.
 */
import React, { memo } from "react";

import ClampedContent, {
  CLAMPED_CONTENT_COMPACT_MAX_HEIGHT,
} from "@src/components/ClampedContent";
import Markdown from "@src/components/MarkDown";

// ============================================
// Helpers
// ============================================

export function extractSummary(content: string): string {
  if (!content) return "";
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,4}\s/.test(trimmed)) continue;
    if (trimmed.startsWith("|")) continue;
    if (/^[-*]\s/.test(trimmed)) continue;
    return trimmed.length > 120 ? trimmed.slice(0, 120) + "..." : trimmed;
  }
  return lines[0].trim();
}

export function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// ============================================
// Prompt Preview
// ============================================

export const SubagentPromptPreview: React.FC<{
  prompt: string;
  /** Tailwind `from-*` class matching the surrounding bubble background so
   *  the collapse fade blends seamlessly (default: the neutral bubble fill). */
  fadeFrom?: string;
}> = memo(({ prompt, fadeFrom = "from-fill-2" }) => (
  // Clamp long assignment prompts to a ~5-line preview with the same
  // expand/collapse pill agent messages use.
  <ClampedContent
    maxHeight={CLAMPED_CONTENT_COMPACT_MAX_HEIGHT}
    fadeFrom={fadeFrom}
    className="allow-select w-full min-w-0"
  >
    <div className="chat-text flex flex-col items-start gap-1 self-stretch text-text-1">
      <div className="resultBgc allow-select w-full min-w-0 overflow-visible font-normal wrap-break-word">
        <Markdown
          textContent={prompt}
          useChatCodeBlock={true}
          enableFileNavigation={true}
          skipPreprocess={false}
        />
      </div>
    </div>
  </ClampedContent>
));
export const SubagentResultPreview: React.FC<{
  content: string;
}> = memo(({ content }) => (
  <div className="chat-text flex flex-col items-start gap-1 self-stretch text-text-1">
    <div className="resultBgc allow-select w-full min-w-0 overflow-visible font-normal wrap-break-word">
      <Markdown
        textContent={content}
        useChatCodeBlock={true}
        enableFileNavigation={true}
        skipPreprocess={false}
      />
    </div>
  </div>
));
SubagentResultPreview.displayName = "SubagentResultPreview";

SubagentPromptPreview.displayName = "SubagentPromptPreview";
