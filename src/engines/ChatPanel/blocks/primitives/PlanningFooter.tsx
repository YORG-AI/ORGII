/**
 * PlanningFooter
 *
 * Inline indicator while the agent is thinking. Picks one phrasing from a
 * localized variant array using the `variantIndex` supplied by
 * usePlanningIndicator — that index is stable for the whole visible span and
 * re-rolls on every hidden → visible transition, so the text varies between
 * waits but never shuffles mid-wait.
 *
 * Visual treatment matches the Thinking block: Sparkle icon painted in
 * primary-6 with the repeating stroke-draw animation, and the label rendered
 * with the shared loading-shimmer text classes. Reuses EventBlockHeaderIcon
 * so the two surfaces can never drift out of sync.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { getEventIcon } from "@src/config/toolIcons";

import { EventBlockHeader } from "./EventBlockHeader";
import { EventBlockHeaderIcon } from "./EventBlockHeaderIcon";
import { EventBlockHeaderTitle } from "./EventBlockHeaderTextSlots";
import { CHAT_ITEM_GAP, CHAT_ITEM_PADDING_X } from "./config";

export type PlanningFooterMode = "planning" | "agentTyping" | "compacting";

interface PlanningFooterProps {
  count: number;
  variantIndex?: number;
  mode?: PlanningFooterMode;
}

function pickVariant(
  variants: unknown,
  index: number,
  fallback: string
): string {
  if (!Array.isArray(variants) || variants.length === 0) {
    return fallback;
  }
  const safe = variants.filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (safe.length === 0) return fallback;
  return safe[index % safe.length] ?? fallback;
}

const PlanningFooter: React.FC<PlanningFooterProps> = ({
  count,
  variantIndex = 0,
  mode = "planning",
}) => {
  const { t } = useTranslation("sessions");
  if (count <= 0) return null;

  const variants = t("planning.nextStepVariants", {
    returnObjects: true,
  }) as unknown;
  const label =
    mode === "compacting"
      ? t("planning.compacting", "Compacting context...")
      : mode === "agentTyping"
        ? t("planning.agentTyping", "Agent is typing...")
        : pickVariant(variants, variantIndex, "Planning next step...");

  return (
    <div
      className={`chat-font-size-wrapper allow-select-deep flex flex-col ${CHAT_ITEM_GAP} ${CHAT_ITEM_PADDING_X} ${DETAIL_PANEL_TOKENS.contentWidth}`}
      data-testid="planning-footer"
    >
      {Array.from({ length: count }, (_, idx) => (
        <div key={idx}>
          <EventBlockHeader isCollapsed withHover={false}>
            <EventBlockHeaderIcon
              icon={getEventIcon("thinking")}
              hasContent={false}
              isLoading
            />
            <EventBlockHeaderTitle isLoading>{label}</EventBlockHeaderTitle>
          </EventBlockHeader>
        </div>
      ))}
    </div>
  );
};

PlanningFooter.displayName = "PlanningFooter";

export default React.memo(PlanningFooter);
