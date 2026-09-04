import React from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import type { CacheRegistryEntryReport } from "@src/util/memory/cacheRegistry";

import { MemoryStatRow } from "./MemoryStatRow";
import { formatCacheBytes } from "./formatters";

interface CacheRegistrySectionProps {
  rows: CacheRegistryEntryReport[];
}

/**
 * Dev-mode list of every cache registered in `cacheRegistry`, largest first.
 * Same row format as the RAM breakdown so the two sections read as one table.
 */
export const CacheRegistrySection: React.FC<CacheRegistrySectionProps> = ({
  rows,
}) => {
  const { t: tSettings } = useTranslation("settings");
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);

  return (
    <>
      <div className={`${DROPDOWN_CLASSES.menuGroupSeparator} my-0.5!`} />
      <MemoryStatRow
        label={`${tSettings("monitor.cacheRegistry")} · ${rows.length}`}
        value={formatCacheBytes(totalBytes)}
        emphasized
      />
      {rows.length === 0 ? (
        <MemoryStatRow
          label={tSettings("monitor.cacheRegistryEmpty")}
          value={null}
          tone="muted"
          indentLevel={1}
        />
      ) : (
        rows.map((row) => {
          const entriesLabel =
            row.entries === null
              ? null
              : tSettings("monitor.cacheRegistryEntries", {
                  count: row.entries,
                });
          const label = [row.id, `T${row.tier}`, entriesLabel]
            .filter(Boolean)
            .join(" · ");
          return (
            <MemoryStatRow
              key={row.id}
              label={label}
              value={row.estimateFailed ? "—" : formatCacheBytes(row.bytes)}
              tone={row.estimateFailed ? "muted" : undefined}
              indentLevel={1}
            />
          );
        })
      )}
    </>
  );
};
