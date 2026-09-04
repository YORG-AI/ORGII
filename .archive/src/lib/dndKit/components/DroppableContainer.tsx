/**
 * DroppableContainer Component
 *
 * Reusable droppable container for dnd-kit.
 * Replaces @hello-pangea/dnd's Droppable component.
 */
import { useDroppable } from "@dnd-kit/core";
import React from "react";

export interface DroppableContainerProps {
  /** Unique identifier for this droppable area */
  id: string;
  /** Content to render inside the droppable area */
  children: React.ReactNode;
  /** Additional className for the container */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
  /** Whether the container is disabled */
  disabled?: boolean;
  /** Render prop for more control */
  renderContainer?: (props: DroppableContainerRenderProps) => React.ReactNode;
}

export interface DroppableContainerRenderProps {
  /** Ref to attach to the droppable element */
  setNodeRef: (node: HTMLElement | null) => void;
  /** Whether an item is currently being dragged over this container */
  isOver: boolean;
  /** The currently active draggable item (if any) */
  active: unknown;
}

export const DroppableContainer: React.FC<DroppableContainerProps> = ({
  id,
  children,
  className,
  style,
  disabled = false,
  renderContainer,
}) => {
  const { setNodeRef, isOver, active } = useDroppable({
    id,
    disabled,
  });

  // Support render prop pattern
  if (renderContainer) {
    return <>{renderContainer({ setNodeRef, isOver, active })}</>;
  }

  // Default rendering
  return (
    <div ref={setNodeRef} className={className} style={style}>
      {children}
    </div>
  );
};

export default DroppableContainer;
