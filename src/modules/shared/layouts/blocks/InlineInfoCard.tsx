import cn from "classnames";
import React from "react";

export interface InlineInfoCardProps {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  dataTestId?: string;
}

const InlineInfoCard: React.FC<InlineInfoCardProps> = ({
  children,
  className,
  contentClassName,
  dataTestId,
}) => {
  return (
    <div
      className={cn(
        "w-0 max-w-full min-w-full overflow-hidden px-2 py-2 contain-[inline-size]",
        className
      )}
      data-testid={dataTestId}
    >
      <div
        className={cn(
          "relative max-w-full min-w-0 overflow-hidden rounded-lg border border-border-2 bg-bg-2 px-4 py-2 contain-[inline-size]",
          contentClassName
        )}
      >
        {children}
      </div>
    </div>
  );
};

export default InlineInfoCard;
