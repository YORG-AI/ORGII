import { Sparkles } from "lucide-react";
import React, { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type HousekeeperContextCompactionState,
  getHousekeeperContextCompactionStatus,
  setHousekeeperContextCompactionEnabled,
} from "@src/api/tauri/agent";
import Switch from "@src/components/Switch";

const EMPTY_STATE: HousekeeperContextCompactionState = {
  enabled: false,
  status: "disabled",
  coveredMessages: 0,
  sourceTokens: 0,
  summaryTokens: 0,
};

interface MiniCpmCompactCardProps {
  sessionId: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MiniCpmCompactCard: React.FC<MiniCpmCompactCardProps> = memo(
  ({ sessionId }) => {
    const { t } = useTranslation();
    const [state, setState] =
      useState<HousekeeperContextCompactionState>(EMPTY_STATE);
    const [pending, setPending] = useState(false);

    const refresh = useCallback(async () => {
      try {
        setState(await getHousekeeperContextCompactionStatus(sessionId));
      } catch (error) {
        setState((current) => ({
          ...current,
          status: "error",
          lastError: errorMessage(error),
        }));
      }
    }, [sessionId]);

    useEffect(() => {
      void refresh();
      const interval = window.setInterval(() => void refresh(), 5_000);
      return () => window.clearInterval(interval);
    }, [refresh]);

    const handleToggle = useCallback(
      async (enabled: boolean) => {
        if (pending) return;
        setPending(true);
        try {
          setState(
            await setHousekeeperContextCompactionEnabled(sessionId, enabled)
          );
        } catch (error) {
          setState((current) => ({
            ...current,
            status: "error",
            lastError: errorMessage(error),
          }));
        } finally {
          setPending(false);
        }
      },
      [pending, sessionId]
    );

    return (
      <section
        data-testid="context-info-minicpm-compact-card"
        className={`overflow-hidden rounded-lg border transition-colors duration-200 ${
          state.enabled
            ? "border-primary-6/25 bg-primary-6/[0.045]"
            : "border-border-2 bg-bg-2"
        }`}
      >
        <div className="flex min-h-[58px] items-center gap-2.5 px-3 py-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-6/10 text-primary-6">
            <Sparkles size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-text-1">
              {t("contextInfo.miniCpmCompactTitle")}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-text-3">
              {t("contextInfo.miniCpmCompactDescription")}
            </span>
          </span>
          <Switch
            checked={state.enabled}
            disabled={pending || state.status === "unavailable"}
            size="default"
            ariaLabel={t("contextInfo.miniCpmCompactToggleAria")}
            dataTestId="context-info-minicpm-compact-switch"
            onChange={(enabled) => void handleToggle(enabled)}
          />
        </div>
      </section>
    );
  }
);

MiniCpmCompactCard.displayName = "MiniCpmCompactCard";

export default MiniCpmCompactCard;
