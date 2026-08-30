/**
 * SortableItem Component
 *
 * Reusable sortable item wrapper for dnd-kit.
 * Replaces @hello-pangea/dnd's Draggable component.
 */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import React from "react";

import { getUiScaleFromCssVar } from "../utils";

export interface SortableItemProps {
  /** Unique identifier for this sortable item */
  id: string;
  /** Content to render inside the sortable item */
  children: React.ReactNode;
  /** Additional className for the wrapper */
  className?: string;
  /** Whether the item is disabled (can't be dragged) */
  disabled?: boolean;
  /** Custom styles to apply */
  style?: React.CSSProperties;
  /** Render prop for more control */
  renderItem?: (props: SortableItemRenderProps) => React.ReactNode;
}

export interface SortableItemRenderProps {
  /** Ref to attach to the draggable element */
  setNodeRef: (node: HTMLElement | null) => void;
  /** Props to spread on the draggable element - spread these on your element */
  attributes: Record<string, unknown>;
  /** Props for the drag handle (use on a child if you want separate handle) */
  listeners: Record<string, unknown> | undefined;
  /** Transform style string */
  transform: string | undefined;
  /** Transition style string */
  transition: string | undefined;
  /** Whether this item is currently being dragged */
  isDragging: boolean;
  /** Whether this item is in a sortable context that's active */
  isSorting: boolean;
  /** Combined style object for convenience */
  style: React.CSSProperties;
}

export const SortableItem: React.FC<SortableItemProps> = ({
  id,
  children,
  className,
  disabled = false,
  style: customStyle,
  renderItem,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isSorting,
  } = useSortable({ id, disabled });

  // Apply UI scale correction to transform
  const uiScale = getUiScaleFromCssVar();
  const correctedTransform = transform
    ? {
        ...transform,
        x: transform.x / uiScale,
        y: transform.y / uiScale,
      }
    : null;

  const transformString = CSS.Transform.toString(correctedTransform);

  const style: React.CSSProperties = {
    transform: transformString,
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: isDragging ? "grabbing" : disabled ? "default" : "grab",
    ...customStyle,
  };

  // Support render prop pattern for more control
  if (renderItem) {
    return (
      <>
        {renderItem({
          setNodeRef,
          attributes: attributes as unknown as Record<string, unknown>,
          listeners: listeners as unknown as
            | Record<string, unknown>
            | undefined,
          transform: transformString,
          transition: transition ?? undefined,
          isDragging,
          isSorting,
          style,
        })}
      </>
    );
  }

  // Default rendering
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

export default SortableItem;
