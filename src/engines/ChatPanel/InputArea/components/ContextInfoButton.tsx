/**
 * ContextInfoButton
 *
 * Circular progress ring in the chat input toolbar. Click opens a popover
 * showing context fill, a segmented breakdown bar, and per-category rows.
 *
 * Data strategy:
 *   - `contextUsage` arrives from Rust after `agent:complete`.
 *   - Sections come from the final provider request payload only.
 *   - Categories with no live data are hidden, no mock/placeholder values.
 */
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  PILL_CONTROL_ACTIVE_SURFACE_CLASS,
  PILL_CONTROL_HOVER_CLASS,
} from "@src/components/CompoundPill/config";
import Textarea from "@src/components/Textarea";
import {
  manualCompactInFlightSessionAtom,
  useManualCompact,
} from "@src/engines/ChatPanel/hooks/useManualCompact";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { useHousekeeperConfig } from "@src/hooks/housekeeper";
import { useSetting } from "@src/hooks/settings/useSettings";
import {
  ArchiveIcon,
  Cancel01Icon,
  ChevronsDownUpIcon,
  HugeiconsIcon,
  UnfoldMoreIcon,
} from "@src/icons";

import ContextBreakdownBar from "./ContextBreakdownBar";
import ContextCategoryRow from "./ContextCategoryRow";
import MiniCpmCompactCard from "./MiniCpmCompactCard";
import ProgressRing from "./ProgressRing";
import { type PanelCategory, ringToneForPercentage } from "./contextInfoTypes";
import { useContextPanel } from "./useContextPanel";
import { formatTokenCount, useContextUsageInfo } from "./useContextUsageInfo";

export interface ContextInfoButtonProps {
  repoPath?: string;
  /**
   * "toolbar" - icon-only button (used in the right toolbar cluster).
   * "corner"  - icon + label pill anchored to the editor's bottom-right.
   */
  variant?: "toolbar" | "corner";
  /**
   * When true, the corner variant omits the text label and shows only the
   * progress ring. Use when horizontal space is tight (inline/compact row).
   */
  compact?: boolean;
}

const ConfiguredMiniCpmCompactCard: React.FC<{ sessionId: string }> = memo(
  ({ sessionId }) => {
    const housekeeper = useHousekeeperConfig();
    if (!housekeeper.isConfigured) return null;
    return (
      <div className="mt-2">
        <MiniCpmCompactCard sessionId={sessionId} />
      </div>
    );
  }
);

ConfiguredMiniCpmCompactCard.displayName = "ConfiguredMiniCpmCompactCard";

function normalizeCategoryTokens(
  categories: PanelCategory[],
  totalTokens: number
): PanelCategory[] {
  const rawTotal = categories.reduce(
    (sum, category) => sum + category.tokens,
    0
  );
  if (rawTotal <= 0 || totalTokens <= 0 || rawTotal <= totalTokens) {
    return categories;
  }

  const scaled = categories.map((category, index) => {
    const exact = (category.tokens / rawTotal) * totalTokens;
    const tokens = Math.floor(exact);
    return {
      category: { ...category, tokens },
      index,
      remainder: exact - tokens,
    };
  });

  const assigned = scaled.reduce(
    (sum, entry) => sum + entry.category.tokens,
    0
  );
  let remaining = Math.max(0, totalTokens - assigned);

  scaled
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((entry) => {
      if (remaining <= 0) return;
      entry.category.tokens += 1;
      remaining -= 1;
    });

  return scaled
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.category)
    .filter((category) => category.tokens > 0);
}

function applyCategoryPercents(
  categories: PanelCategory[],
  totalTokens: number
): PanelCategory[] {
  if (totalTokens <= 0) return categories;

  const exactPercentages = categories.map((category, index) => {
    const exact = (category.tokens / totalTokens) * 100;
    const percent = Math.floor(exact);
    return {
      index,
      percent,
      remainder: exact - percent,
    };
  });

  const currentTotal = exactPercentages.reduce(
    (sum, entry) => sum + entry.percent,
    0
  );
  const targetTotal =
    categories.reduce((sum, category) => sum + category.tokens, 0) >=
    totalTokens
      ? 100
      : currentTotal;
  let remaining = Math.max(0, targetTotal - currentTotal);

  exactPercentages
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((entry) => {
      if (remaining <= 0) return;
      entry.percent += 1;
      remaining -= 1;
    });

  const percentsByIndex = exactPercentages
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.percent);

  return categories.map((category, index) => ({
    ...category,
    percent: percentsByIndex[index] ?? 0,
  }));
}

const ContextInfoButton: React.FC<ContextInfoButtonProps> = memo(
  ({ variant = "toolbar", compact = false }) => {
    const { t } = useTranslation();
    const { sessionId } = useSessionId();
    const [housekeeperEnabled] = useSetting("housekeeper.enabled");
    const [contextCompactEnabled] = useSetting(
      "housekeeper.features.contextCompact"
    );
    const { runManualCompact: runSharedManualCompact } = useManualCompact();
    const compactingSessionId = useAtomValue(manualCompactInFlightSessionAtom);
    const {
      percentage,
      tokenLabel,
      maxTokens,
      displayTokens,
      contextUsage,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRate,
      cacheSavedTokens,
    } = useContextUsageInfo();

    const { panelPos, triggerRef, panelRef, toggle, close } = useContextPanel();
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const [compactInstructions, setCompactInstructions] = useState("");
    const [manualCompactOpen, setManualCompactOpen] = useState(false);
    // Shared in-flight state: covers compactions started from this popover
    // AND from the `/compact` slash command.
    const manualCompacting = compactingSessionId !== null;

    const ringTone = ringToneForPercentage(percentage);
    const displayPct = percentage > 100 ? 100 : percentage;
    const cornerLabelClass =
      ringTone === "unused" ? "text-text-4" : "text-text-2";
    const hasCache = cacheReadTokens > 0 || cacheWriteTokens > 0;
    // Surface the cache savings as the hero line whenever there is a
    // meaningful hit rate. This is ORGII's cost advantage over CC / Codex /
    // Cursor and the thing the user should notice first.
    const showCacheHero = cacheHitRate > 0.05 && cacheSavedTokens > 0;
    // Keep the corner pill calm: only show the running percentage once we are
    // actually approaching the auto-compaction zone.
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
      const rawCategories = (contextUsage?.sections ?? [])
        .filter((section) => section.estimatedTokens > 0)
        .map((section) => ({
          key: section.category,
          label: section.label,
          tokens: section.estimatedTokens,
          percent: 0,
          hex: colors[section.category] ?? colors.other,
        }));

      const totalTokens = displayTokens;
      if (rawCategories.length === 0 || totalTokens <= 0) {
        return rawCategories.map((category) => ({
          ...category,
          percent: category.percent,
        }));
      }

      const rawTotal = rawCategories.reduce(
        (sum, category) => sum + category.tokens,
        0
      );
      const categories =
        rawTotal > totalTokens
          ? normalizeCategoryTokens(rawCategories, totalTokens)
          : rawCategories;
      const categoryTotal = categories.reduce(
        (sum, category) => sum + category.tokens,
        0
      );
      if (categoryTotal > 0 && categoryTotal < totalTokens) {
        const delta = totalTokens - categoryTotal;
        const unattributedIndex = categories.findIndex(
          (category) => category.key === "unattributed"
        );
        if (unattributedIndex >= 0) {
          categories[unattributedIndex] = {
            ...categories[unattributedIndex],
            tokens: categories[unattributedIndex].tokens + delta,
          };
        } else {
          categories.push({
            key: "unattributed",
            label: t("contextInfo.categories.unattributed", {
              defaultValue: "Unattributed",
            }),
            tokens: delta,
            percent: 0,
            hex: colors.unattributed,
          });
        }
      }

      return applyCategoryPercents(categories, totalTokens);
    }, [contextUsage, displayTokens, t]);

    const handleMouseEnter = useCallback(
      (key: string) => () => setHoveredKey(key),
      []
    );
    const handleMouseLeave = useCallback(() => setHoveredKey(null), []);
    const runManualCompact = useCallback(async () => {
      if (manualCompacting) return;
      const compacted = await runSharedManualCompact(
        sessionId,
        compactInstructions
      );
      // React 18: state updates after unmount are safe no-ops, so the
      // popover closing mid-compaction needs no mounted guard here.
      if (compacted) setCompactInstructions("");
    }, [
      manualCompacting,
      sessionId,
      compactInstructions,
      runSharedManualCompact,
    ]);

    const handleInstructionsKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          event.nativeEvent.isComposing
        )
          return;
        event.preventDefault();
        void runManualCompact();
      },
      [runManualCompact]
    );

    const compactDisabled = manualCompacting;
    const triggerSurfaceClass =
      panelPos !== null
        ? PILL_CONTROL_ACTIVE_SURFACE_CLASS
        : PILL_CONTROL_HOVER_CLASS;

    return (
      <>
        {variant === "corner" ? (
          <button
            ref={triggerRef}
            data-testid="context-info-button"
            className={`flex h-[28px] shrink-0 items-center gap-1.5 rounded-full text-text-3 transition-colors duration-200 ${triggerSurfaceClass} ${compact ? "w-[28px] justify-center px-0" : "px-2"}`}
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
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-3 transition-colors duration-150 hover:text-text-2 ${triggerSurfaceClass}`}
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
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      data-icon="x"
                      size={12}
                    />
                  </button>
                </div>

                <p className="mt-0.5 text-[13px] text-text-3">{tokenLabel}</p>

                {!manualCompactOpen &&
                  (showCacheHero ? (
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
                  ))}

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

              {!manualCompactOpen && categories.length > 0 && (
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

              <div className="border-t border-border-2 bg-fill-1/30 px-3.5 py-2">
                <button
                  type="button"
                  data-testid="context-info-manual-compact-toggle"
                  onClick={() => setManualCompactOpen((open) => !open)}
                  aria-expanded={manualCompactOpen}
                  className="group flex w-full items-center justify-between rounded px-1 py-1 text-left"
                >
                  <span className="text-[13px] font-semibold text-text-1">
                    {t("contextInfo.manualCompactSectionTitle")}
                  </span>
                  <span className="flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors group-hover:bg-fill-2 group-hover:text-text-2">
                    {manualCompactOpen ? (
                      <HugeiconsIcon
                        icon={ChevronsDownUpIcon}
                        data-icon="chevrons-down-up"
                        size={12}
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={UnfoldMoreIcon}
                        data-icon="chevrons-up-down"
                        size={12}
                      />
                    )}
                  </span>
                </button>

                {manualCompactOpen && (
                  <div className="mt-2">
                    <Textarea
                      size="small"
                      autoSize={{ minRows: 2, maxRows: 5 }}
                      data-testid="context-info-compact-instructions-input"
                      value={compactInstructions}
                      onChange={(value) => setCompactInstructions(value)}
                      onKeyDown={handleInstructionsKeyDown}
                      placeholder={t(
                        "contextInfo.manualCompactInstructionsPlaceholder"
                      )}
                    />
                    <Button
                      long
                      variant="secondary"
                      size="small"
                      className="mt-2"
                      data-testid="context-info-manual-compact-button"
                      icon={
                        <HugeiconsIcon
                          icon={ArchiveIcon}
                          data-icon="archive"
                          size={14}
                        />
                      }
                      loading={manualCompacting}
                      disabled={compactDisabled}
                      onClick={runManualCompact}
                    >
                      {manualCompacting
                        ? t("contextInfo.manualCompactRunning")
                        : t("contextInfo.manualCompactAction")}
                    </Button>

                    {housekeeperEnabled &&
                      contextCompactEnabled &&
                      sessionId && (
                        <ConfiguredMiniCpmCompactCard sessionId={sessionId} />
                      )}
                  </div>
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
