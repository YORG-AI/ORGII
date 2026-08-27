/**
 * useTableColumns
 *
 * Adapter that converts our internal `TableColumn<T>[]` shape into the
 * `ColumnDef<T>[]` shape TanStack expects.
 *
 * IMPORTANT — do not inline a fresh `cell` function on each invocation.
 *
 * TanStack's `flexRender(cell, ctx)` calls
 *   `isReactComponent(cell) ? React.createElement(cell, ctx) : cell`
 * which means when `cell` is a function, React treats *the function
 * itself* as the component type. Recreating the function on every
 * `useMemo` recompute (e.g. because a parent passed a new `columns`
 * reference, which happens whenever any upstream prop or inline arrow
 * changes) produces a brand-new component type for every cell. React
 * then unmounts the whole cell subtree and mounts a new one — which
 * tears down any stateful descendant mid-interaction.
 *
 * Symptom: the "flash and disappear" bug on table-cell dropdowns. The
 * dropdown opens, parent re-renders for any reason, every cell's
 * `useDropdownEngine` instance gets unmounted, the new instance starts
 * back at `isOpen: false`, and the panel vanishes.
 *
 * Fix: we hand TanStack ONE stable module-level component
 * (`CellRenderer`) and stash the per-column `render` function on the
 * column's `meta`. `CellRenderer` looks it up at render time. Same
 * pattern for `HeaderRenderer`. Now component identity is constant
 * across renders → React reconciles cell subtrees in place →
 * stateful descendants survive.
 */
import {
  CellContext,
  ColumnDef,
  HeaderContext,
  Row,
  Table as TanStackTable,
} from "@tanstack/react-table";
import { useMemo } from "react";

import Checkbox from "@src/components/Checkbox";

import { IndeterminateCheckbox } from "./helpers";
import type { TableColumn, TableProps } from "./types";

interface CellMeta<T> {
  render?: (value: unknown, record: T, index: number) => React.ReactNode;
}

function CellRenderer<T>(info: CellContext<T, unknown>): React.ReactNode {
  const meta = info.column.columnDef.meta as
    | (CellMeta<T> & Record<string, unknown>)
    | undefined;
  const render = meta?.render;
  if (render) {
    return render(info.getValue(), info.row.original, info.row.index);
  }
  return info.getValue() as React.ReactNode;
}

function HeaderRenderer<T>(info: HeaderContext<T, unknown>): React.ReactNode {
  const meta = info.column.columnDef.meta as
    | { headerTitle?: React.ReactNode }
    | undefined;
  return meta?.headerTitle ?? null;
}

export function useTableColumns<T>(
  columns: TableColumn<T>[],
  rowSelection: TableProps<T>["rowSelection"]
): ColumnDef<T>[] {
  return useMemo<ColumnDef<T>[]>(() => {
    const cols: ColumnDef<T>[] = [];

    if (rowSelection) {
      cols.push({
        id: "select",
        header: ({ table }: { table: TanStackTable<T> }) =>
          rowSelection.type !== "radio" ? (
            <IndeterminateCheckbox
              checked={table.getIsAllRowsSelected()}
              indeterminate={table.getIsSomeRowsSelected()}
              onChange={table.getToggleAllRowsSelectedHandler()}
            />
          ) : null,
        cell: ({ row }: { row: Row<T> }) =>
          rowSelection.type === "radio" ? (
            <input
              type="radio"
              checked={row.getIsSelected()}
              onChange={row.getToggleSelectedHandler()}
              className="table-checkbox"
            />
          ) : (
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={(_checked, event) =>
                row.getToggleSelectedHandler()(event)
              }
              className="table-checkbox"
            />
          ),
        size: 48,
      });
    }

    columns.forEach((col) => {
      const accessorKey = col.dataIndex || col.key;
      const customSorter =
        typeof col.sorter === "function" ? col.sorter : undefined;
      const hasTitle = col.title !== undefined && col.title !== null;
      cols.push({
        id: col.key || col.dataIndex,
        accessorKey: accessorKey as string,
        header: hasTitle ? HeaderRenderer<T> : undefined,
        cell: CellRenderer<T>,
        size: typeof col.width === "number" ? col.width : undefined,
        enableSorting: !!col.sorter,
        sortingFn: customSorter
          ? (rowA, rowB) => customSorter(rowA.original, rowB.original)
          : undefined,
        meta: {
          align: col.align || "left",
          width: col.width,
          hideBelow: col.hideBelow,
          render: col.render,
          headerTitle: col.title,
        },
      });
    });

    return cols;
  }, [columns, rowSelection]);
}
