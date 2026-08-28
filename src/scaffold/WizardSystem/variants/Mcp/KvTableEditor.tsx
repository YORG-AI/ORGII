/**
 * Reusable key-value pair table editor for MCP wizard (env vars, headers).
 */
import React, { useMemo } from "react";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { Delete02Icon, HugeiconsIcon } from "@src/icons";

export interface KvRow {
  id: string;
  key: string;
  value: string;
}

export function kvRowsFromRecord(record: Record<string, string>): KvRow[] {
  return Object.entries(record).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value,
  }));
}

export function kvRowsToRecord(rows: KvRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const trimmed = row.key.trim();
    if (trimmed) record[trimmed] = row.value;
  }
  return record;
}

interface KvTableEditorProps {
  rows: KvRow[];
  onUpdate: (id: string, field: "key" | "value", val: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  keyLabel: string;
  valueLabel: string;
  addLabel: string;
}

export const KvTableEditor: React.FC<KvTableEditorProps> = ({
  rows,
  onUpdate,
  onRemove,
  onAdd,
  keyLabel,
  valueLabel,
  addLabel,
}) => {
  const columns = useMemo<SettingsTableColumn<KvRow>[]>(
    () => [
      {
        key: "key",
        label: keyLabel,
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <Input
            value={row.key}
            onChange={(val) => onUpdate(row.id, "key", val)}
            placeholder={keyLabel}
            size="default"
            className="w-full"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        ),
      },
      {
        key: "value",
        label: valueLabel,
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <Input
            value={row.value}
            onChange={(val) => onUpdate(row.id, "value", val)}
            placeholder={valueLabel}
            size="default"
            className="w-full"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (row) => (
          <Button
            variant="secondary"
            size="default"
            icon={
              <HugeiconsIcon
                icon={Delete02Icon}
                data-icon="trash-2"
                size={14}
                className="text-danger-6"
              />
            }
            iconOnly
            onClick={() => onRemove(row.id)}
          />
        ),
      },
    ],
    [keyLabel, valueLabel, onUpdate, onRemove]
  );

  return (
    <SettingsTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      dense
      noPx
      addFooter={{ label: addLabel, onClick: onAdd }}
    />
  );
};
