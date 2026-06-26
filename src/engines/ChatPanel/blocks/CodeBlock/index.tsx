/**
 * ChatCodeBlock Component
 *
 * A code block component for chat history display.
 * Features:
 * - Collapsible header with smooth animation
 * - Language-specific icons
 * - NO internal scrolling - shows limited lines with "Show more" button
 * - Hover to show collapse controls
 * - Diff syntax highlighting with + (green) and - (red)
 * - Intersection observer for lazy syntax highlighting
 * - Virtual scrolling for large code blocks (>100 lines)
 */
import { ArrowUpRight, Check, Clipboard, Eye, EyeOff } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import ExpandOverlay from "@src/components/ExpandOverlay";
import { FileTreeHoverPreview } from "@src/components/FileTreePreview/exports";
import FileTypeIcon from "@src/components/FileTypeIcon";
import ModernCodeViewer from "@src/features/CodeViewer/ModernCodeViewer";
import { VirtualizedModernDiff } from "@src/features/CodeViewer/VirtualizedModernDiff";
import { useCopyCheck } from "@src/hooks/ui";
import { copyText } from "@src/util/data/clipboard";
import { openFileInEditor } from "@src/util/ui/openFileInEditor";

import {
  EVENT_BLOCK_FADE_FROM,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EVENT_LOADING_SHIMMER_TEXT_CLASSES,
  EVENT_SNIPPET_INNER_PADDING_CLASS,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";
import CodePreview from "./CodePreview";
import { STYLE_CONFIG } from "./config";
import type { ParsedDiff } from "./diffParser";
import "./index.scss";
import { useCodeBlockState } from "./useCodeBlockState";

// ============================================
// Constants
// ============================================

const TRAILING_TAG_TONE_CLASS = {
  success: "font-medium text-success-6",
  danger: "font-medium text-danger-6",
  muted: "font-medium text-text-3",
  secondary: "font-medium text-text-2",
} as const;

// ============================================
// Types
// ============================================

export interface ChatCodeBlockProps {
  code: string;
  language?: string;
  filePath?: string;
  title?: string;
  subtitle?: string;
  actionTitle?: string;
  actionIcon?: React.ReactNode;
  separateTitle?: boolean;
  defaultCollapsed?: boolean;
  maxHeight?: number;
  containerWidth?: number;
  showLineNumbers?: boolean;
  className?: string;
  hideHeader?: boolean;
  visibleLines?: number;
  linesAdded?: number;
  linesRemoved?: number;
  showLineCount?: boolean;
  diffPayload?: ParsedDiff;
  trailingTags?: ReadonlyArray<{
    tone: "success" | "danger" | "muted" | "secondary";
    text: string;
  }>;
  hasContent?: boolean;
  eventId?: string;
  isLoading?: boolean;
  isFailed?: boolean;
  showFileTreeHover?: boolean;
  showCopyButton?: boolean;
  showOpenButton?: boolean;
}

// ============================================
// Component
// ============================================

const ChatCodeBlock: React.FC<ChatCodeBlockProps> = memo(
  ({
    code,
    language,
    filePath,
    title,
    subtitle,
    actionTitle,
    actionIcon,
    separateTitle = false,
    defaultCollapsed = false,
    containerWidth,
    showLineNumbers: _showLineNumbers = true,
    className = "",
    hideHeader = false,
    visibleLines,
    linesAdded,
    linesRemoved,
    showLineCount = true,
    diffPayload,
    trailingTags,
    hasContent = true,
    eventId,
    isLoading = false,
    isFailed = false,
    showFileTreeHover = true,
    showCopyButton = true,
    showOpenButton = false,
  }) => {
    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({ defaultCollapsed, eventId, collapseAllValue: true });
    const { t } = useTranslation("sessions");
    const onCopyContent = useCallback(async () => {
      await copyText(code);
    }, [code]);
    const { copied, handleCopy } = useCopyCheck(onCopyContent);
    const handleCopyContent = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        handleCopy();
      },
      [handleCopy]
    );
    const handleOpenFile = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (filePath) openFileInEditor(filePath);
      },
      [filePath]
    );
    const shouldShowCopyButton =
      showCopyButton && hasContent && Boolean(code) && !isCollapsed;
    const shouldShowOpenButton =
      showOpenButton && hasContent && Boolean(filePath) && !isCollapsed;

    const {
      useTerminalLayout,
      isExpanded,
      setIsExpanded,
      isPreviewOpen,
      handleTogglePreview,
      detectedLanguage,
      isPreviewable,
      iconFileName,
      displayTitle,
      isDiff,
      addedLines,
      removedLines,
      shouldShowLineCount,
      needsExpand,
      displayedCode,
      displayedDiff,
      contentHeight,
      useVirtualScroll,
      virtualListHeight,
      isScrolling,
      containerRefCb,
      streamingWrapperRef,
    } = useCodeBlockState({
      code,
      language,
      filePath,
      title,
      actionTitle,
      separateTitle,
      isLoading,
      visibleLines,
      linesAdded,
      linesRemoved,
      showLineCount,
      diffPayload,
      isCollapsed,
    });

    const containerClass = useTerminalLayout
      ? `group group/expand ${getEventBlockContainerClasses(false)}`
      : `group ${getEventBlockContainerClasses()} ${className}`;

    return (
      <div className={containerClass}>
        {!hideHeader && (
          <EventBlockHeader
            isCollapsed={isCollapsed}
            className={
              useTerminalLayout || isCollapsed || (isLoading && !code)
                ? "border-b border-solid border-transparent"
                : "border-b border-solid border-border-1"
            }
            onClick={hasContent ? handleLocate : undefined}
            onNavigate={
              eventId && !shouldShowCopyButton ? handleLocate : undefined
            }
            onMouseEnter={handleHeaderMouseEnter}
            onMouseLeave={handleHeaderMouseLeave}
            withHover={!useTerminalLayout && hasContent}
          >
            <EventBlockHeaderIcon
              icon={
                actionIcon || (
                  <FileTypeIcon
                    fileName={iconFileName}
                    size="small"
                    className="text-primary-6"
                  />
                )
              }
              isCollapsed={isCollapsed}
              isHeaderHovered={isHeaderHovered}
              iconSize={16}
              onToggle={handleHeaderClick}
              hasContent={hasContent}
              revealChevronOnIconHoverOnly={Boolean(eventId)}
              isLoading={isLoading}
              isFailed={isFailed}
            />

            {actionTitle && (
              <span
                className={`shrink-0 ${isLoading ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}` : "font-medium text-text-1"}`}
              >
                {actionTitle}
              </span>
            )}

            {!useTerminalLayout && (
              <>
                {filePath ? (
                  showFileTreeHover ? (
                    <FileTreeHoverPreview
                      path={filePath}
                      itemType="file"
                      className="flex-initial"
                    >
                      <div
                        className={`min-w-0 cursor-pointer truncate hover:underline ${
                          isLoading
                            ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`
                            : actionTitle
                              ? "text-text-2"
                              : "font-medium text-text-1"
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openFileInEditor(filePath);
                        }}
                      >
                        {displayTitle}
                      </div>
                    </FileTreeHoverPreview>
                  ) : (
                    <div
                      className={`min-w-0 flex-initial cursor-pointer truncate hover:underline ${
                        isLoading
                          ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`
                          : actionTitle
                            ? "text-text-2"
                            : "font-medium text-text-1"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFileInEditor(filePath);
                      }}
                    >
                      {displayTitle}
                    </div>
                  )
                ) : (
                  <div
                    className={`min-w-0 flex-initial truncate ${
                      isLoading
                        ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`
                        : actionTitle
                          ? "text-text-2"
                          : "font-medium text-text-1"
                    }`}
                  >
                    {displayTitle}
                  </div>
                )}

                {subtitle && (
                  <EventBlockHeaderSubtitle
                    isLoading={isLoading}
                    title={subtitle}
                  >
                    {subtitle}
                  </EventBlockHeaderSubtitle>
                )}

                {(shouldShowLineCount ||
                  (trailingTags && trailingTags.length > 0)) && (
                  <span className="flex shrink-0 items-center gap-1.5">
                    {shouldShowLineCount && (
                      <DiffStatsBadge
                        additions={addedLines}
                        deletions={removedLines}
                        variant="plain"
                        className="translate-y-px gap-0"
                      />
                    )}
                    {trailingTags?.map((tag, idx) => (
                      <span
                        key={idx}
                        className={TRAILING_TAG_TONE_CLASS[tag.tone]}
                      >
                        {tag.text}
                      </span>
                    ))}
                  </span>
                )}

                {shouldShowOpenButton && (
                  <Button
                    variant="tertiary"
                    appearance="ghost"
                    size="mini"
                    iconOnly
                    icon={<ArrowUpRight size={12} strokeWidth={1.75} />}
                    title={t("common:actions.open")}
                    aria-label={t("common:actions.open")}
                    className="ml-auto shrink-0 text-text-4 hover:text-text-2"
                    onClick={handleOpenFile}
                  />
                )}

                {shouldShowCopyButton && (
                  <Button
                    variant="tertiary"
                    appearance="ghost"
                    size="mini"
                    iconOnly
                    icon={
                      copied ? (
                        <Check size={12} strokeWidth={1.75} />
                      ) : (
                        <Clipboard size={12} strokeWidth={1.75} />
                      )
                    }
                    title={
                      copied
                        ? t("common:status.copied")
                        : t("common:actions.copy")
                    }
                    aria-label={
                      copied
                        ? t("common:status.copied")
                        : t("common:actions.copy")
                    }
                    className={`shrink-0 text-text-4 hover:text-text-2 ${
                      shouldShowOpenButton ? "" : "ml-auto"
                    }`}
                    onClick={handleCopyContent}
                  />
                )}

                {isPreviewable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTogglePreview();
                    }}
                    className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
                      shouldShowCopyButton || shouldShowOpenButton
                        ? ""
                        : "ml-auto"
                    } ${
                      isPreviewOpen
                        ? "bg-primary-6/15 text-primary-6 hover:bg-primary-6/25"
                        : "text-text-4 hover:bg-fill-3 hover:text-text-2"
                    }`}
                    title={
                      isPreviewOpen
                        ? t("codePreview.hidePreview")
                        : t("codePreview.showPreview")
                    }
                  >
                    {isPreviewOpen ? <EyeOff size={11} /> : <Eye size={11} />}
                    {t("codePreview.preview")}
                  </button>
                )}
              </>
            )}
          </EventBlockHeader>
        )}

        {hasContent && !isCollapsed && !(isLoading && !code) && (
          <div
            ref={
              isLoading && !useTerminalLayout ? streamingWrapperRef : undefined
            }
            className={
              useTerminalLayout
                ? EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES
                : `group/expand relative ${isLoading ? "scrollbar-hide" : isExpanded && needsExpand ? "scrollbar-hide" : ""}`
            }
            style={
              useTerminalLayout
                ? undefined
                : isLoading
                  ? {
                      maxHeight: (visibleLines ?? 15) * 18 + 16,
                      overflowY: "auto",
                      overflowX: "hidden",
                      transition: `opacity ${STYLE_CONFIG.animationDuration}ms ease-out`,
                    }
                  : {
                      opacity: isCollapsed ? 0 : 1,
                      overflow:
                        isExpanded && needsExpand ? undefined : "hidden",
                      maxHeight:
                        isExpanded && needsExpand
                          ? "40vh"
                          : needsExpand
                            ? contentHeight
                            : undefined,
                      overflowY: isExpanded && needsExpand ? "auto" : undefined,
                      overflowX:
                        isExpanded && needsExpand ? "hidden" : undefined,
                      transition: `opacity ${STYLE_CONFIG.animationDuration}ms ease-out`,
                    }
            }
          >
            {useTerminalLayout && filePath && (
              <div
                className={`flex items-center gap-2 ${EVENT_SNIPPET_INNER_PADDING_CLASS}`}
              >
                <FileTypeIcon
                  fileName={filePath}
                  size="small"
                  className="flex-shrink-0 text-text-2"
                />
                <span
                  className="min-w-0 flex-1 cursor-pointer truncate text-text-1 hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    openFileInEditor(filePath);
                  }}
                >
                  {displayTitle}
                </span>
              </div>
            )}

            <div
              className={
                useTerminalLayout
                  ? "relative border-t border-solid border-border-1 pt-1"
                  : "py-1"
              }
            >
              <div
                ref={containerRefCb}
                className="chat-code-block__code-container chat-code-block__scroll-hover w-full min-w-0 max-w-full overflow-x-auto overflow-y-hidden"
                data-scrolling={isScrolling || undefined}
              >
                {isDiff && displayedDiff ? (
                  <VirtualizedModernDiff
                    oldValue={displayedDiff.oldValue}
                    newValue={displayedDiff.newValue}
                    filePath={filePath}
                    height={contentHeight}
                    width={containerWidth}
                    collapseUnchanged={true}
                    contextLines={2}
                    showFilePath={false}
                    showStatsBar={false}
                    showLineNumbers={false}
                    internalScroll={false}
                    noWrapper={true}
                    allowExpand={false}
                    indicatorStyle="border"
                    className="chat-event-diff"
                    oldStartLine={displayedDiff.oldStartLine}
                    newStartLine={displayedDiff.newStartLine}
                  />
                ) : (
                  <ModernCodeViewer
                    content={useVirtualScroll ? code : displayedCode}
                    language={detectedLanguage}
                    showLineNumbers={false}
                    internalScroll={useVirtualScroll}
                    height={
                      useVirtualScroll ? virtualListHeight : contentHeight
                    }
                    width={containerWidth}
                    noWrapper={true}
                  />
                )}
              </div>

              {needsExpand && !isLoading && (
                <ExpandOverlay
                  isExpanded={isExpanded}
                  onToggle={() => setIsExpanded(!isExpanded)}
                  fadeFrom={EVENT_BLOCK_FADE_FROM}
                />
              )}
            </div>
          </div>
        )}

        {isPreviewable && isPreviewOpen && (
          <CodePreview
            code={code}
            language={detectedLanguage}
            onClose={handleTogglePreview}
          />
        )}
      </div>
    );
  }
);

ChatCodeBlock.displayName = "ChatCodeBlock";

export default ChatCodeBlock;
