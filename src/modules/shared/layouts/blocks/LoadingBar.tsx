import React from "react";
import { useTranslation } from "react-i18next";

import ProgressBar from "@src/components/ProgressBar";

export interface LoadingBarProps {
  ariaLabel?: string;
  className?: string;
}

/** A compact, text-free loading indicator for panel and table surfaces. */
const LoadingBar: React.FC<LoadingBarProps> = ({
  ariaLabel,
  className = "",
}) => {
  const { t } = useTranslation("common");

  return (
    <ProgressBar
      percent={0}
      indeterminate
      ariaLabel={ariaLabel ?? t("status.loading")}
      height="h-0.5"
      width="w-full"
      trackColor="bg-transparent"
      className={`shrink-0 rounded-none ${className}`.trim()}
    />
  );
};

export default LoadingBar;
