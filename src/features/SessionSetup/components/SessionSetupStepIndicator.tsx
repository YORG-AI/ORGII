import type { FC } from "react";

interface SessionSetupStepIndicatorProps {
  step: number;
  currentStep: number;
  label: string;
  completed: boolean;
}

const SessionSetupStepIndicator: FC<SessionSetupStepIndicatorProps> = ({
  step,
  currentStep,
  label,
  completed,
}) => {
  const isActive = step === currentStep;
  const isPast = step < currentStep || completed;

  return (
    <div className="flex items-center gap-1.5">
      <div
        className={[
          "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
          isPast
            ? "bg-success-6 text-text-white"
            : isActive
              ? "bg-primary-6 text-text-white"
              : "border border-border-2 bg-bg-2 text-text-3",
        ].join(" ")}
      >
        {isPast ? <span className="text-[10px]">✓</span> : step}
      </div>
      <span
        className={[
          "text-[12px]",
          isActive ? "font-medium text-text-1" : "font-normal text-text-3",
        ].join(" ")}
      >
        {label}
      </span>
    </div>
  );
};

export default SessionSetupStepIndicator;
