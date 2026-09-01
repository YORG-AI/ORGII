import React from "react";

import { SETTINGS_TABLE_CELL } from "@src/components/SettingsTable";

export function formatEnabledFraction(enabled: number, total: number): string {
  return `${enabled}/${total}`;
}

interface EnabledFractionTextProps {
  enabled: number;
  total: number;
  className?: string;
}

/**
 * Consistent enabled/total count for Integrations tables and inline card headers.
 * Numerator uses emphasis styling; denominator is muted.
 */
export const EnabledFractionText: React.FC<EnabledFractionTextProps> = ({
  enabled,
  total,
  className,
}) => {
  if (total <= 0) return null;

  return (
    <span
      className={`whitespace-nowrap tabular-nums ${className ?? ""}`.trim()}
    >
      <span className={SETTINGS_TABLE_CELL.value}>{enabled}</span>
      <span className="text-text-4">/</span>
      <span className={SETTINGS_TABLE_CELL.muted}>{total}</span>
    </span>
  );
};

interface DotEnabledFractionProps {
  enabled: number;
  total: number;
  className?: string;
}

/** Middle-dot prefix + enabled/total, used on model group list rows. */
export function DotEnabledFraction({
  enabled,
  total,
  className,
}: DotEnabledFractionProps) {
  if (total <= 0) return null;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 ${className ?? ""}`.trim()}
    >
      <span className="text-text-4">·</span>
      <EnabledFractionText enabled={enabled} total={total} />
    </span>
  );
}

interface DotEnabledCountProps {
  enabled: number;
  total: number;
  className?: string;
}

/** Middle-dot prefix + enabled count only (no /total), for model group rows. */
export function DotEnabledCount({
  enabled,
  total,
  className,
}: DotEnabledCountProps) {
  if (total <= 0) return null;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 tabular-nums ${className ?? ""}`.trim()}
    >
      <span className="text-text-4">·</span>
      <span className={SETTINGS_TABLE_CELL.value}>{enabled}</span>
    </span>
  );
}

interface DotVariantCountProps {
  count: number;
  label: string;
  className?: string;
  hideWhenZero?: boolean;
}

/** Middle-dot prefix + localized variant count label (e.g. "· 11 variants"). */
export function DotVariantCount({
  count,
  label,
  className,
  hideWhenZero = true,
}: DotVariantCountProps) {
  if (hideWhenZero && count <= 0) return null;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-normal text-text-2 tabular-nums ${className ?? ""}`.trim()}
    >
      <span className="text-text-4">·</span>
      <span>{label}</span>
    </span>
  );
}
