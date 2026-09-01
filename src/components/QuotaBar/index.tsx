/**
 * QuotaBar — quota progress display (shared UI; not market-specific).
 *
 * Variants:
 * - "inline": Compact text (e.g., "92% left")
 * - "compact": Label + bar
 * - "full": Used/limit + bar
 */
import React from "react";

import { HugeiconsIcon, Tick01Icon } from "@src/icons";

export function getQuotaTextColorClass(percentage: number): string {
  if (percentage < 10) return "text-danger-6";
  if (percentage < 30) return "text-warning-6";
  return "text-success-6";
}

export function getQuotaBgColorClass(percentage: number): string {
  if (percentage < 10) return "bg-danger-6";
  if (percentage < 30) return "bg-warning-6";
  return "bg-success-6";
}

export interface QuotaBarProps {
  remainingPercent: number;
  isUnlimited?: boolean;
  label?: React.ReactNode;
  used?: number;
  limit?: number;
  planType?: string;
  formatValue?: (value: number) => string;
  variant?: "inline" | "compact" | "full";
  showLabel?: boolean;
  showUsedPercent?: boolean;
  barHeight?: string;
  className?: string;
}

const QuotaBar: React.FC<QuotaBarProps> = ({
  remainingPercent: rawRemainingPercent,
  isUnlimited = false,
  label,
  used,
  limit,
  planType,
  formatValue = (value) => value.toLocaleString(),
  variant = "compact",
  showLabel = true,
  showUsedPercent = false,
  barHeight = "h-2",
  className = "",
}) => {
  const remainingPercent = Math.max(0, Math.min(100, rawRemainingPercent));
  const usedPercent = 100 - remainingPercent;
  const textColorClass = getQuotaTextColorClass(remainingPercent);
  const bgColorClass = getQuotaBgColorClass(remainingPercent);

  if (variant === "inline") {
    return (
      <span
        className={`text-[11px] font-medium ${textColorClass} ${className}`}
      >
        {isUnlimited ? "∞" : `${Math.round(remainingPercent)}% left`}
      </span>
    );
  }

  if (variant === "compact") {
    return (
      <div className={className}>
        {showLabel && label && (
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] text-text-2">{label}</span>
            <span className={`text-[12px] font-medium ${textColorClass}`}>
              {isUnlimited
                ? "Unlimited"
                : `${Math.round(remainingPercent)}% left`}
            </span>
          </div>
        )}
        {showLabel && !label && (
          <div className="mb-1 flex justify-end">
            <span className={`text-[12px] font-medium ${textColorClass}`}>
              {isUnlimited
                ? "Unlimited"
                : `${Math.round(remainingPercent)}% left`}
            </span>
          </div>
        )}
        <div
          className={`w-full overflow-hidden rounded-full bg-fill-3 ${barHeight}`}
        >
          <div
            className={`h-full rounded-full transition-all ${bgColorClass}`}
            style={{ width: `${isUnlimited ? 100 : remainingPercent}%` }}
          />
        </div>
        {showUsedPercent && !isUnlimited && usedPercent > 0 && (
          <div className="mt-0.5 text-right text-[10px] text-text-2">
            {Math.round(usedPercent)}% used
          </div>
        )}
        {planType && (
          <div className="mt-1 text-[11px] text-text-2">Plan: {planType}</div>
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      {showLabel && (
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[12px] text-text-2">
            {label || "Quota Usage"}
          </span>
          <div className="flex items-center gap-2">
            {used != null && limit != null && limit > 0 && (
              <span className="text-[11px] text-text-2">
                {formatValue(used)} / {formatValue(limit)}
              </span>
            )}
            <span className={`text-[12px] font-medium ${textColorClass}`}>
              {isUnlimited
                ? "Unlimited"
                : `${Math.round(remainingPercent)}% left`}
            </span>
          </div>
        </div>
      )}
      <div
        className={`w-full overflow-hidden rounded-full bg-fill-3 ${barHeight}`}
      >
        <div
          className={`h-full rounded-full transition-all ${bgColorClass}`}
          style={{ width: `${isUnlimited ? 100 : remainingPercent}%` }}
        />
      </div>
      {showUsedPercent && !isUnlimited && usedPercent > 0 && (
        <div className="mt-0.5 text-right text-[10px] text-text-2">
          {Math.round(usedPercent)}% used
        </div>
      )}
    </div>
  );
};

export default QuotaBar;

interface QuotaBarInlineProps {
  remainingPercent: number;
  isUnlimited?: boolean;
  showBar?: boolean;
  className?: string;
}

export const QuotaBarInline: React.FC<QuotaBarInlineProps> = ({
  remainingPercent: rawRemainingPercent,
  isUnlimited = false,
  showBar = false,
  className = "",
}) => {
  const remainingPercent = Math.max(0, Math.min(100, rawRemainingPercent));
  const textColorClass = getQuotaTextColorClass(remainingPercent);
  const bgColorClass = getQuotaBgColorClass(remainingPercent);

  if (!showBar) {
    return (
      <span
        className={`text-[11px] font-medium ${textColorClass} ${className}`}
      >
        {isUnlimited ? "∞" : `${Math.round(remainingPercent)}% left`}
      </span>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-fill-3">
        <div
          className={`h-full rounded-full ${bgColorClass}`}
          style={{ width: `${isUnlimited ? 100 : remainingPercent}%` }}
        />
      </div>
      <span className={`text-[11px] font-medium ${textColorClass}`}>
        {isUnlimited ? "∞" : `${Math.round(remainingPercent)}%`}
      </span>
    </div>
  );
};

interface QuotaStatusBarProps {
  remainingPercent: number;
  isUnlimited?: boolean;
  isLoggedIn?: boolean;
  planType?: string;
  className?: string;
}

export const QuotaStatusBar: React.FC<QuotaStatusBarProps> = ({
  remainingPercent: rawRemainingPercent,
  isUnlimited = false,
  isLoggedIn = true,
  planType,
  className = "",
}) => {
  const remainingPercent = Math.max(0, Math.min(100, rawRemainingPercent));
  const textColorClass = getQuotaTextColorClass(remainingPercent);
  const bgColorClass = getQuotaBgColorClass(remainingPercent);

  return (
    <div
      className={`flex items-center gap-3 rounded-md bg-fill-1 px-3 py-2 ${className}`}
    >
      {isLoggedIn && (
        <>
          <div className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={Tick01Icon}
              data-icon="check"
              size={12}
              className="text-success-6"
              strokeWidth={3}
            />
            <span className="text-[11px] text-text-2">Logged in</span>
          </div>
          <div className="h-3 border-r border-border-2" />
        </>
      )}
      <div className="flex flex-1 items-center gap-2">
        <span className="text-[11px] text-text-3">Quota:</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill-3">
          <div
            className={`h-full rounded-full ${bgColorClass}`}
            style={{ width: `${isUnlimited ? 100 : remainingPercent}%` }}
          />
        </div>
        <span className={`text-[11px] font-medium ${textColorClass}`}>
          {isUnlimited ? "∞" : `${Math.round(remainingPercent)}%`}
        </span>
      </div>
      {planType && (
        <>
          <div className="h-3 border-r border-border-2" />
          <span className="text-[11px] text-text-3">{planType}</span>
        </>
      )}
    </div>
  );
};
