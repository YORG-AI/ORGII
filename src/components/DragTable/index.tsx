/**
 * DragTable — generic drag-to-reorder table for settings pages.
 *
 * Renders a native <table> with table-settings CSS classes, dnd-kit
 * vertical reorder, a built-in GripVertical drag handle, and an
 * optional "+ Add" footer.
 *
 * Does NOT render its own card container — place inside a SectionContainer
 * (or any `bg-fill-2 px-4` wrapper) for the standard card look.
 * Use `noPx` when nested in SectionContainer to drop duplicate edge cell padding.
 *
 * Consumers define columns; the drag handle column is injected
 * automatically as the first column.
 *
 * @example
 * ```tsx
 * <SectionContainer>
 *   <DragTable
 *     columns={[
 *       { key: "name", label: "Name", renderCell: (row) => <Input value={row.name} /> },
 *       { key: "role", label: "Role", style: { paddingLeft: 16 }, renderCell: ... },
 *     ]}
 *     rows={items}
 *     onChange={setItems}
 *     headerHeight="tall"
 *     onAdd={handleAdd}
 *     addLabel="Add item"
 *   />
 * </SectionContainer>
 * ```
 */
import { DndContext, type DragEndEvent, closestCenter } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import React, { type ReactNode, useCallback, useMemo } from "react";

import Button from "@src/components/Button";
import { Add01Icon, GripVerticalIcon, HugeiconsIcon } from "@src/icons";
import { useWebViewSensors } from "@src/lib/dndKit";

// ── Public Types ──

export interface DragTableColumn<T> {
  key: string;
  /** Header label. Omit for icon-only columns (grip, delete). */
  label?: string;
  /** Fixed width (number = px, string = CSS value). Omit for auto/fill. */
  width?: number | string;
  /** Style applied to both <th> and <td> (e.g. paddingLeft). */
  style?: React.CSSProperties;
  /** Render cell content. Receives the row data and its current visual index. */
  renderCell: (row: T, index: number) => ReactNode;
}

interface DragTableProps<T extends { id: string }> {
  columns: DragTableColumn<T>[];
  rows: T[];
  /**
   * Called with the reordered rows after a drag completes. Pass a no-op
   * only in combination with `readOnly`; otherwise reordering will be
   * silently swallowed.
   */
  onChange: (rows: T[]) => void;
  /** @default "tall" */
  headerHeight?: "compact" | "tall";
  /** When provided, renders a "+ Add" footer button. */
  onAdd?: () => void;
  /** Label for the add button. Required when onAdd is provided. */
  addLabel?: string;
  /** Stable selector for the add button. */
  addButtonDataTestId?: string;
  /** Text shown when rows is empty. */
  emptyText?: string;
  /** When true, removes horizontal padding on first/last columns (table-settings-no-px). */
  noPx?: boolean;
  /**
   * When true, hides the drag handle column and skips the DnD wiring
   * entirely. Use for read-only listings (e.g. provider credentials)
   * where reordering has no semantic meaning. `onChange` is never
   * invoked in this mode.
   */
  readOnly?: boolean;
}

// ── Constants ──

/** Width of the drag-handle column. Hugs the 14px GripVertical icon plus
 *  a few px of breathing room — no left gutter padding (see grip-cell rule). */
const GRIP_WIDTH = 24;
const GRIP_CELL_STYLE: React.CSSProperties = {
  width: GRIP_WIDTH,
  paddingLeft: 0,
  paddingRight: 0,
};
const ADD_BUTTON_CLASS = "text-text-3 hover:text-text-1";

// ── Sortable Row (internal) ──

interface SortableRowProps<T extends { id: string }> {
  row: T;
  index: number;
  columns: DragTableColumn<T>[];
}

function SortableRowInner<T extends { id: string }>({
  row,
  index,
  columns,
}: SortableRowProps<T>) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <tr ref={setNodeRef} style={style} className="group table-row">
      <td className="table-td" style={GRIP_CELL_STYLE}>
        <span
          className="flex cursor-grab items-center justify-center text-text-4"
          {...attributes}
          {...listeners}
        >
          <HugeiconsIcon
            icon={GripVerticalIcon}
            data-icon="grip-vertical"
            size={14}
          />
        </span>
      </td>
      {columns.map((col) => (
        <td
          key={col.key}
          className="table-td"
          style={{
            ...(col.width != null
              ? { width: typeof col.width === "number" ? col.width : col.width }
              : {}),
            ...col.style,
          }}
        >
          {col.renderCell(row, index)}
        </td>
      ))}
    </tr>
  );
}

const SortableRow = React.memo(SortableRowInner) as typeof SortableRowInner;

// ── Static (read-only) Row ──
//
// Same visual cell layout as SortableRow but with no grip column and no
// dnd-kit wiring. Lets `readOnly` consumers drop into the same table
// chrome without splitting the component.

function StaticRowInner<T extends { id: string }>({
  row,
  index,
  columns,
}: SortableRowProps<T>) {
  return (
    <tr className="group table-row">
      {columns.map((col) => (
        <td
          key={col.key}
          className="table-td"
          style={{
            ...(col.width != null
              ? { width: typeof col.width === "number" ? col.width : col.width }
              : {}),
            ...col.style,
          }}
        >
          {col.renderCell(row, index)}
        </td>
      ))}
    </tr>
  );
}

const StaticRow = React.memo(StaticRowInner) as typeof StaticRowInner;

// ── Main Component ──

function DragTableInner<T extends { id: string }>({
  columns,
  rows,
  onChange,
  headerHeight = "tall",
  onAdd,
  addLabel,
  addButtonDataTestId,
  emptyText,
  noPx = false,
  readOnly = false,
}: DragTableProps<T>) {
  const sensors = useWebViewSensors();

  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = rows.findIndex((row) => row.id === active.id);
      const newIndex = rows.findIndex((row) => row.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      onChange(arrayMove(rows, oldIndex, newIndex));
    },
    [rows, onChange]
  );

  const tallClass = headerHeight === "tall" ? "table-settings-tall" : "";
  const noPxClass = noPx ? "table-settings-no-px" : "";
  // Read-only tables drop the grip column entirely.
  const colSpan = columns.length + (readOnly ? 0 : 1);

  return (
    <>
      <div
        className={`table-wrapper table-size-small table-settings table-settings-dense ${tallClass} ${noPxClass}`.trim()}
      >
        <div className="table-container">
          <div className="table-scroll" style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%" }}>
              <thead className="table-thead">
                <tr>
                  {readOnly ? null : (
                    <th className="table-th" style={GRIP_CELL_STYLE} />
                  )}
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className="table-th"
                      style={{
                        ...(col.width != null
                          ? {
                              width:
                                typeof col.width === "number"
                                  ? col.width
                                  : col.width,
                            }
                          : {}),
                        ...col.style,
                      }}
                    >
                      {col.label ? (
                        <div className="table-th-content">{col.label}</div>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="table-tbody">
                {rows.length > 0 ? (
                  readOnly ? (
                    rows.map((row, index) => (
                      <StaticRow
                        key={row.id}
                        row={row}
                        index={index}
                        columns={columns}
                      />
                    ))
                  ) : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      modifiers={[restrictToVerticalAxis]}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={rowIds}
                        strategy={verticalListSortingStrategy}
                      >
                        {rows.map((row, index) => (
                          <SortableRow
                            key={row.id}
                            row={row}
                            index={index}
                            columns={columns}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  )
                ) : (
                  <tr>
                    <td
                      colSpan={colSpan}
                      className="py-6 text-center text-[12px] text-text-3"
                    >
                      {emptyText ?? ""}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {onAdd && (
        <div className="flex items-center py-2">
          <Button
            variant="tertiary"
            size="default"
            icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
            onClick={onAdd}
            className={ADD_BUTTON_CLASS}
            data-testid={addButtonDataTestId}
          >
            {addLabel}
          </Button>
        </div>
      )}
    </>
  );
}

const DragTable = React.memo(DragTableInner) as typeof DragTableInner;

export default DragTable;
