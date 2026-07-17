import React from "react";

import { classNames } from "@src/util/ui/classNames";

interface PropertiesRailFrameProps {
  children: React.ReactNode;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  className?: string;
  contentClassName?: string;
  floatingContent?: boolean;
}

function toCssSize(value: number | string | undefined): string | undefined {
  return typeof value === "number" ? `${value}px` : value;
}

const PropertiesRailFrame: React.FC<PropertiesRailFrameProps> = ({
  children,
  width,
  minWidth,
  maxWidth,
  className,
  contentClassName,
  floatingContent = false,
}) => {
  const sizeStyle = {
    width: toCssSize(width),
    minWidth: toCssSize(minWidth),
    maxWidth: toCssSize(maxWidth),
  };

  if (floatingContent) {
    return (
      <div
        className={classNames(
          "box-border flex h-full shrink-0 flex-col",
          className
        )}
        style={sizeStyle}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={classNames(
        "box-border flex h-full shrink-0 flex-col border-l border-solid border-border-2",
        className
      )}
      style={sizeStyle}
    >
      <div
        className={classNames(
          "min-h-0 flex-1 overflow-hidden",
          contentClassName
        )}
      >
        {children}
      </div>
    </div>
  );
};

export default PropertiesRailFrame;
