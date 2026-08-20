/**
 * "● ○ ○ Thinking · 24s" — a ticking seconds counter with a three-dot
 * pulse, shown under whichever seat is to act.
 */
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export interface ThinkingIndicatorProps {
  /** Epoch ms when the actor's turn started. */
  since: number;
}

const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ since }) => {
  const { t } = useTranslation("sessions");
  // Wall-clock tick; `since` only feeds the derived seconds below.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(handle);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const active = Math.floor(now / 400) % 3;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-text-3">
      <span aria-hidden className="flex items-center gap-[3px]">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className={`h-[5px] w-[5px] rounded-full ${dot === active ? "bg-text-2" : "bg-fill-3"}`}
          />
        ))}
      </span>
      {t("pokerTable.thinking", { seconds })}
    </span>
  );
};

export default ThinkingIndicator;
