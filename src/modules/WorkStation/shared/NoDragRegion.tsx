import React, { forwardRef } from "react";

interface NoDragRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
}

const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export const NoDragRegion = forwardRef<HTMLDivElement, NoDragRegionProps>(
  ({ children, className, style, ...props }, ref) => (
    <div
      ref={ref}
      className={className}
      {...props}
      data-tauri-drag-region="false"
      style={{ ...style, ...NO_DRAG_STYLE }}
    >
      {children}
    </div>
  )
);

NoDragRegion.displayName = "NoDragRegion";

export default NoDragRegion;
