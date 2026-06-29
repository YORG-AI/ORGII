/**
 * ContextInfoButton
 *
 * Circular progress ring in the chat input toolbar. Click opens a popover
 * showing context fill, a segmented breakdown bar, and per-category rows.
 *
 * Data strategy:
 *   - `contextUsage` arrives from Rust after `agent:complete`.
 *   - Sections come from the final provider request payload only.
 *   - Categories with no live data are hidden — no mock/placeholder values.
 */
import { X } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import ContextBreakdownBar from "./ContextBreakdownBar";
import ContextCategoryRow from "./ContextCategoryRow";
import ProgressRing from "./ProgressRing";
import { type PanelCategory, ringToneForPercentage } from "./contextInfoTypes";
import { useContextCacheSnapshot } from "./useContextCacheSnapshot";
import { useContextPanel } from "./useContextPanel";
import { formatTokenCount, useContextUsageInfo } from "./useContextUsageInfo";

export interface ContextInfoButtonProps {
  repoPath?: string;
  sessionId?: string;
  /**
   * "toolbar" — icon-only button (used in the right toolbar cluster).
   * "corner"  — icon + label pill anchored to the editor's bottom-right.
   */
  variant?: "toolbar" | "corner";
  /**
   * When true, the corner variant omits the text label and shows only the
   * progress ring. Use when horizontal space is tight (inline/compact row).
   */
  compact?: boolean;
}

const ContextInfoButton: React.FC<ContextInfoButtonProps> = memo(
  ({ sessionId, variant = "toolbar", compact = false }) => {
    const { t } = useTranslation();
    const {
      percentage,
      tokenLabel,
      maxTokens,
      contextUsage,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate,
      cacheSavedTokens,
    } = useContextUsageInfo();

    const { panelPos, triggerRef, panelRef, toggle, close } = useContextPanel();
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const { snapshot: contextCacheSnapshot, error: contextCacheError } =
      useContextCacheSnapshot(sessionId, panelPos !== null);

    const ringTone = ringToneForPercentage(percentage);
    const displayPct = percentage > 100 ? 100 : percentage;
    const cornerLabelClass =
      ringTone === "unused" ? "text-text-4" : "text-text-2";
    const hasCache = cacheReadTokens > 0 || cacheWriteTokens > 0;
    // Surface the cache savings as the hero line whenever there is a
    // meaningful hit rate — this is ORGII's cost advantage over CC / Codex /
    // Cursor and the thing the user should notice first.
    const showCacheHero = cacheHitRate > 0.05 && cacheSavedTokens > 0;
    // Keep the corner pill calm: only show the running percentage once we are
    // actually approaching the auto-compaction zone, otherwise the gauge sits
    // quietly without a number nagging the user.
    const showCornerPercent = percentage >= 90;

    const categories: PanelCategory[] = useMemo(() => {
      const colors: Record<string, string> = {
        stable_prompt: "#9ca3af",
        dynamic_prompt: "#a78bfa",
        rules: "#34d399",
        skills: "#fbbf24",
        memory: "#22c55e",
        conversation: "#fb923c",
        tool_results: "#60a5fa",
        attachments: "#e879f9",
        other: "#94a3b8",
        unattributed: "#f87171",
      };
      return (contextUsage?.sections ?? [])
        .filter((section) => section.estimatedTokens > 0)
        .map((section) => ({
          key: section.category,
          label: section.label,
          tokens: section.estimatedTokens,
          percent: section.percent,
          hex: colors[section.category] ?? colors.other,
        }));
    }, [contextUsage]);

    const latestCacheLayout = contextCacheSnapshot?.latestCacheLayout;
    const embeddingState = contextCacheSnapshot?.embeddingState;
    const importedSnapshots = contextCacheSnapshot?.snapshots ?? [];
    const formatOptionalTokens = (value: number | undefined | null) =>
      formatTokenCount(Math.max(0, value ?? 0));

    const handleMouseEnter = useCallback(
      (key: string) => () => setHoveredKey(key),
      []
    );
    const handleMouseLeave = useCallback(() => setHoveredKey(null), []);

    return (
      <>
        {variant === "corner" ? (
          <button
            ref={triggerRef}
            data-testid="context-info-button"
            className={`flex h-[28px] shrink-0 items-center gap-1.5 rounded-full text-text-3 transition-colors duration-200 hover:bg-fill-2 ${compact ? "w-[28px] justify-center px-0" : "px-2"}`}
            onClick={toggle}
            aria-label={t("contextInfo.ariaLabel")}
            aria-expanded={panelPos !== null}
          >
            <ProgressRing percentage={displayPct} tone={ringTone} />
            {!compact && showCornerPercent && (
              <span
                className={`text-[12px] tabular-nums leading-none ${cornerLabelClass}`}
              >
                {percentage.toFixed(0)}%
              </span>
            )}
          </button>
        ) : (
          <button
            ref={triggerRef}
            data-testid="context-info-button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-3 transition-colors duration-150 hover:bg-fill-2 hover:text-text-2"
            onClick={toggle}
            aria-label={t("contextInfo.ariaLabel")}
            aria-expanded={panelPos !== null}
          >
            <ProgressRing percentage={displayPct} tone={ringTone} />
          </button>
        )}

        {panelPos &&
          createPortal(
            <div
              ref={panelRef}
              data-testid="context-info-panel"
              className="fixed z-[99999] w-[320px] overflow-hidden rounded-xl border border-border-2 bg-bg-2 shadow-2xl"
              style={{ bottom: panelPos.bottom, right: panelPos.right }}
            >
              {/* Header */}
              <div className="px-4 pb-3 pt-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-text-1">
                    {t("contextInfo.title")}
                  </span>
                  <button
                    type="button"
                    onClick={close}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-2"
                    aria-label={t("common:actions.close")}
                  >
                    <X size={12} />
                  </button>
                </div>

                <p className="mt-0.5 text-[13px] text-text-3">{tokenLabel}</p>

                {showCacheHero ? (
                  <div className="mt-2 rounded-lg bg-green-500/10 px-2.5 py-1.5">
                    <p className="text-[12px] font-semibold text-green-600">
                      {t("contextInfo.cacheHero", {
                        pct: Math.round(cacheHitRate * 100),
                        tokens: formatTokenCount(cacheSavedTokens),
                      })}
                    </p>
                    <p className="mt-0.5 text-[10.5px] leading-snug text-text-3">
                      {t("contextInfo.cacheHeroSub")}
                    </p>
                  </div>
                ) : (
                  hasCache && (
                    <p className="mt-0.5 text-[11px] text-green-600">
                      {t("contextInfo.cacheSaved", {
                        read: formatTokenCount(cacheReadTokens),
                        write: formatTokenCount(cacheWriteTokens),
                      })}
                    </p>
                  )
                )}

                {ringTone !== "unused" && ringTone !== "normal" && (
                  <p className="mt-1 text-[11px] leading-snug text-text-3">
                    {t("contextInfo.autoCompactNote")}
                  </p>
                )}

                <div className="mt-3">
                  <ContextBreakdownBar
                    categories={categories}
                    maxTokens={maxTokens}
                    hoveredKey={hoveredKey}
                    fallbackPercentage={percentage}
                  />
                </div>
              </div>

              {/* Category rows — only rendered when there is live data */}
              {categories.length > 0 && (
                <div className="px-4 py-2">
                  <div className="flex flex-col">
                    {categories.map((cat) => (
                      <ContextCategoryRow
                        key={cat.key}
                        categoryKey={cat.key}
                        label={cat.label}
                        tokens={cat.tokens}
                        percent={cat.percent}
                        hex={cat.hex}
                        isHovered={hoveredKey === cat.key}
                        onMouseEnter={handleMouseEnter(cat.key)}
                        onMouseLeave={handleMouseLeave}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div
                className="border-t border-border-2 px-4 py-2.5"
                data-testid="context-cache-debug-panel"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-text-4">
                    Cache layout
                  </span>
                  {!contextCacheSnapshot && !contextCacheError && (
                    <span className="text-text-5 text-[10px]">Loading…</span>
                  )}
                </div>
                {contextCacheError ? (
                  <p className="text-text-5 mt-1 text-[10.5px] leading-snug">
                    Debug snapshot unavailable: {contextCacheError}
                  </p>
                ) : (
                  <>
                    <div className="mt-2 grid grid-cols-2 gap-1 text-[10.5px] text-text-4">
                      <div className="rounded bg-fill-2 px-2 py-1">
                        <span className="text-text-5 block">Stable prefix</span>
                        <span className="font-mono text-text-2">
                          {formatOptionalTokens(
                            latestCacheLayout?.stablePrefixTokens
                          )}
                        </span>
                      </div>
                      <div className="rounded bg-fill-2 px-2 py-1">
                        <span className="text-text-5 block">Volatile</span>
                        <span className="font-mono text-text-2">
                          {formatOptionalTokens(
                            latestCacheLayout?.volatileContextTokens
                          )}
                        </span>
                      </div>
                      <div className="rounded bg-fill-2 px-2 py-1">
                        <span className="text-text-5 block">Imported</span>
                        <span className="font-mono text-text-2">
                          {latestCacheLayout?.importedContextCount ??
                            importedSnapshots.length}
                        </span>
                      </div>
                      <div className="rounded bg-fill-2 px-2 py-1">
                        <span className="text-text-5 block">
                          Provider cache
                        </span>
                        <span className="font-mono text-text-2">
                          {latestCacheLayout?.providerCacheHitRate != null
                            ? `${Math.round(latestCacheLayout.providerCacheHitRate * 100)}%`
                            : "—"}
                        </span>
                      </div>
                    </div>
                    {importedSnapshots.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {importedSnapshots.slice(0, 4).map((snapshot) => (
                          <span
                            key={snapshot.snapshotId}
                            className="rounded bg-fill-3 px-1.5 py-0.5 font-mono text-[10px] text-text-4"
                          >
                            {snapshot.namespace}
                          </span>
                        ))}
                      </div>
                    )}
                    {embeddingState && (
                      <p className="mt-2 text-[10.5px] leading-snug text-text-4">
                        Embedded through seq{" "}
                        {embeddingState.lastEmbeddedSequence} ·{" "}
                        {embeddingState.namespace}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>,
            document.body
          )}
      </>
    );
  }
);

ContextInfoButton.displayName = "ContextInfoButton";

export default ContextInfoButton;
