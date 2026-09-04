import React, { memo } from "react";

interface HeaderSectionSeparatorProps {
  className?: string;
}

const HeaderSectionSeparatorComponent: React.FC<
  HeaderSectionSeparatorProps
> = ({ className = "" }) => (
  <span
    className={`pointer-events-none h-4 w-px shrink-0 bg-border-2 ${className}`.trim()}
    aria-hidden
  />
);

export const HeaderSectionSeparator = memo(HeaderSectionSeparatorComponent);
HeaderSectionSeparator.displayName = "HeaderSectionSeparator";
