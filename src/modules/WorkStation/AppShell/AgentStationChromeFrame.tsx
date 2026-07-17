import React from "react";

interface AgentStationChromeFrameProps {
  enabled: boolean;
  illuminated: boolean;
  captionVisible?: boolean;
  hasSession: boolean;
  children: React.ReactNode;
}

const AgentStationChromeFrame: React.FC<AgentStationChromeFrameProps> = ({
  enabled,
  illuminated,
  captionVisible = false,
  hasSession,
  children,
}) => {
  if (!enabled) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    );
  }

  const frameClassName = illuminated
    ? "border-primary-6/80 ring-2 ring-primary-6/15"
    : "border-border-2";

  const innerRadiusClass = "rounded-page";
  const framePaddingClass = captionVisible ? "px-2 pb-2" : "p-2";
  const borderWidthClass = hasSession ? "border-[1.5px]" : "border";

  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${framePaddingClass}`}
    >
      {illuminated && (
        <div
          className={`station-chrome-static-glow pointer-events-none absolute inset-2 z-0 ${innerRadiusClass} bg-[radial-gradient(circle_at_50%_100%,color-mix(in_srgb,var(--color-primary-6)_14%,transparent),transparent_58%)]`}
        />
      )}
      <div
        className={`relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${innerRadiusClass} ${borderWidthClass} bg-workstation-bg ${frameClassName}`}
      >
        <div
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${innerRadiusClass}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

AgentStationChromeFrame.displayName = "AgentStationChromeFrame";

export default AgentStationChromeFrame;
