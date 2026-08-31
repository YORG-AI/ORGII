/**
 * DragOverlayItem Component
 *
 * Wrapper for drag overlay content with proper styling.
 * Used inside DragOverlay to show the item being dragged.
 */
import React from "react";

export interface DragOverlayItemProps {
  /** Content to render in the overlay */
  children: React.ReactNode;
  /** Additional className */
  className?: string;
  /** Custom styles */
  style?: React.CSSProperties;
  /** Whether to add a drop shadow effect */
  withShadow?: boolean;
  /** Whether to scale up slightly for visual feedback */
  withScale?: boolean;
}

export const DragOverlayItem: React.FC<DragOverlayItemProps> = ({
  children,
  className,
  style,
  withShadow = true,
  withScale = false,
}) => {
  const overlayStyle: React.CSSProperties = {
    cursor: "grabbing",
    ...(withShadow && {
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15)",
    }),
    ...(withScale && {
      transform: "scale(1.02)",
    }),
    ...style,
  };

  return (
    <div className={className} style={overlayStyle}>
      {children}
    </div>
  );
};

export default DragOverlayItem;
