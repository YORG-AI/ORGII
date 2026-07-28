import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { Highlight, HighlightKind } from "@src/api/tauri/builderProfile";
import { STAT_GRID_TOKENS } from "@src/modules/shared/layouts/blocks";

/**
 * One fact per card: the question, the answer, and the line that makes the
 * answer mean something.
 *
 * The deck arrives already interleaved by family, so the grid renders it in
 * order — reading down the page alternates between records, rhythm, craft,
 * style and totals rather than marching through five blocks of the same shape.
 * `kind` only tints the question line; the card layout stays identical so the
 * grid reads as one set. The surface matches the Usage page's stat tiles, and
 * the grid is placed directly in the page flow — wrapping it in a section
 * container would put a card inside a card.
 *
 * The backend sends ids and raw numbers, never prose. Everything a locale can
 * disagree about is decided here: thousands separators, date format, and
 * whether an hour reads as "5 PM" or "17:00".
 */
const KIND_TINT: Record<HighlightKind, string> = {
  extreme: "text-primary-6",
  rhythm: "text-success-5",
  craft: "text-warning-5",
  style: "text-text-2",
  scale: "text-text-3",
};

/**
 * 12-hour AM/PM, everywhere. Deliberately not `toLocaleTimeString`: that hands
 * the choice to the locale, and a 24-hour rendering ("15时", "15 h") reads as a
 * timestamp rather than as a time of day, which is what this card is about.
 */
function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** Params that are not plain counts and need formatting before interpolation. */
function formatParams(
  params: Record<string, number>,
  locale: string
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "seconds") {
      out.duration = formatDuration(value, locale);
    } else if (key === "dateMs") {
      out.date = new Date(value).toLocaleDateString(locale, {
        day: "numeric",
        month: "long",
      });
    } else if (key === "hour") {
      out.hour = hourLabel(value);
    } else {
      out[key] = value.toLocaleString(locale);
    }
  }
  return out;
}

function formatDuration(seconds: number, locale: string): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  // Intl.NumberFormat carries each locale's own unit abbreviation ("2 hr",
  // "2 Std.", "2 時間"), which a hand-rolled "2h" would get wrong everywhere.
  const unit = (value: number, u: "hour" | "minute") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: u,
      unitDisplay: "narrow",
    }).format(value);
  if (hours && minutes)
    return `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
  if (hours) return unit(hours, "hour");
  return unit(Math.max(minutes, 1), "minute");
}

const HighlightCards = memo(function HighlightCards({
  highlights,
}: {
  highlights: Highlight[];
}) {
  const { t, i18n } = useTranslation("builderProfile");
  const locale = i18n.language || "en";

  if (highlights.length === 0) return null;

  return (
    <div
      className={STAT_GRID_TOKENS.cols3}
      data-testid="builder-profile-highlights"
    >
      {highlights.map((card) => {
        const values = formatParams(card.params, locale);
        return (
          <div
            key={card.id}
            className="flex flex-col gap-1.5 rounded-xl border border-border-1 bg-primary-container p-4"
            data-testid={`highlight-${card.id}`}
          >
            <span
              className={`text-xs ${KIND_TINT[card.kind] ?? "text-text-3"}`}
            >
              {t(`cards.${card.id}.question`)}
            </span>
            <span className="text-lg font-semibold leading-tight text-text-1">
              {t(`cards.${card.id}.headline`, values)}
            </span>
            <span className="text-xs leading-snug text-text-3">
              {t(`cards.${card.detailId}.detail`, values)}
            </span>
          </div>
        );
      })}
    </div>
  );
});

export default HighlightCards;
