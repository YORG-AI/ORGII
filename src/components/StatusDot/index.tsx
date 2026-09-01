/**
 * StatusDot
 *
 * Canonical status indicator: coloured dot + optional label. Replaces the
 * dozen hand-rolled `inline-block h-2 w-2 rounded-full` clusters that used to
 * live across Integrations tables, KeyVault detail panels, MCP / Channel /
 * Launchpad rows, and the AgentOrgs CLI detail view.
 *
 * Variants:
 *   - `size="table"` — sized by the surrounding table cell typography
 *     (`SETTINGS_TABLE_CELL.value`), no explicit text size.
 *   - `size="inline"` — `text-[12px]` and `text-text-1`, used inside inline
 *     expanded cards and detail-panel rows that have no ambient cell typography.
 *   - `size="sm"` — alias of `inline` with a slightly tighter gap, for dense
 *     lists (used by CategoryRow-style breakdowns).
 *
 * The dot can be made to pulse (used by MCP / Channel "connecting" states)
 * via `pulse`. A trailing `count` renders a "· N" suffix used by CliClients.
 *
 * NOTE: Component path stays at `@src/components/StatusDot` so the Tables
 * shared.tsx wrapper just re-exports from here; existing callers keep their
 * imports.
 */
import React, { memo } from "react";

import { SETTINGS_TABLE_CELL } from "@src/components/SettingsTable";

type StatusDotSize = "table" | "inline" | "sm";

export interface StatusDotProps {
  /** Tailwind background class for the dot, e.g. `bg-success-6`. */
  color: string;
  /** Optional label rendered after the dot. */
  label?: React.ReactNode;
  /**
   * `"table"` (default) uses `SETTINGS_TABLE_CELL.value` typography — picks
   *   up the surrounding settings-table cell font sizing.
   * `"inline"` adds explicit `text-[12px] text-text-1` for use inside inline
   *   expanded cards / detail-panel rows.
   * `"sm"` is a tighter dense-list variant (`text-xs`).
   */
  size?: StatusDotSize;
  /** Override label classes (takes effect when `size !== "table"`). */
  labelClassName?: string;
  /** Apply `animate-pulse` to the dot — used for "connecting" states. */
  pulse?: boolean;
  /** Trailing "· N" count rendered after the label (CliClients usage). */
  count?: number;
  /** Forwarded to the wrapper for assistive tech / test selectors. */
  ariaLabel?: string;
  /** Wrapper class override for callers that need extra layout tweaks. */
  className?: string;
}

const StatusDot: React.FC<StatusDotProps> = memo(
  ({
    color,
    label,
    size = "table",
    labelClassName,
    pulse = false,
    count,
    ariaLabel,
    className,
  }) => {
    const labelClasses =
      size === "table"
        ? SETTINGS_TABLE_CELL.value
        : (labelClassName ??
          (size === "sm"
            ? "text-xs text-text-2"
            : "text-[12px] font-medium text-text-1"));

    return (
      <div
        className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className ?? ""}`}
        aria-label={ariaLabel}
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <span
            className={`inline-block h-2 w-2 rounded-full ${color} ${
              pulse ? "animate-pulse" : ""
            }`}
          />
        </span>
        {label !== undefined && label !== null && (
          <span className={labelClasses}>{label}</span>
        )}
        {count !== undefined && (
          <>
            <span className="text-text-4">·</span>
            <span className={`tabular-nums ${labelClasses}`}>{count}</span>
          </>
        )}
      </div>
    );
  }
);

StatusDot.displayName = "StatusDot";

export default StatusDot;
