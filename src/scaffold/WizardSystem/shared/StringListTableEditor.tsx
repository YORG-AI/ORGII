/**
 * Single-column string list editor for wizard forms (required binaries, env names, etc.).
 * Matches SettingsTable styling used by KvTableEditor (dense + noPx).
 */
import React, { useMemo } from "react";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import SettingsTable, {
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { Delete02Icon, HugeiconsIcon } from "@src/icons";

interface IndexedStringRow {
  index: number;
  value: string;
}

/** When the saved list is empty, still show one editable row in the table. */
function listForEdit(values: string[]): string[] {
  return values.length === 0 ? [""] : values;
}

interface StringListTableEditorProps {
  values: string[];
  onChange: (next: string[]) => void;
  valueLabel: string;
  placeholder: string;
  addLabel: string;
}

export const StringListTableEditor: React.FC<StringListTableEditorProps> = ({
  values,
  onChange,
  valueLabel,
  placeholder,
  addLabel,
}) => {
  const rows = useMemo<IndexedStringRow[]>(() => {
    const list = listForEdit(values);
    return list.map((value, index) => ({ index, value }));
  }, [values]);

  const columns = useMemo<SettingsTableColumn<IndexedStringRow>[]>(
    () => [
      {
        key: "value",
        label: valueLabel,
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <Input
            value={row.value}
            onChange={(val) => {
              const list = listForEdit(values);
              const next = [...list];
              next[row.index] = val;
              onChange(next);
            }}
            placeholder={placeholder}
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
            onClick={() => {
              const list = listForEdit(values);
              onChange(list.filter((_, rowIndex) => rowIndex !== row.index));
            }}
          />
        ),
      },
    ],
    [values, valueLabel, placeholder, onChange]
  );

  return (
    <SettingsTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => `string-list-${row.index}`}
      dense
      noPx
      addFooter={{
        label: addLabel,
        onClick: () => onChange([...listForEdit(values), ""]),
      }}
    />
  );
};
