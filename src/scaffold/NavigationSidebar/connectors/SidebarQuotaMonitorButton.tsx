/**
 * SidebarQuotaMonitorButton — ZenMux quota monitoring panel.
 *
 * Sidebar button (Activity icon) that opens a floating dropdown showing
 * ZenMux 5h / 7d quota usage percentages with progress bars.
 */
import { Activity } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { ZenmuxQuotaStatus } from "@src/api/tauri/rpc/schemas/quota";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";

import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../components/HoverAnimatedIcon";

// ── Poll interval ────────────────────────────────────────────────────────

const QUOTA_POLL_MS = 30_000; // 30 s (backend caches 5 min anyway)

// ── Hook ─────────────────────────────────────────────────────────────────

function useQuotaData(isOpen: boolean) {
  const [quota, setQuota] = useState<ZenmuxQuotaStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchQuota = useCallback(async () => {
    setLoading(true);
    const result = await rpc.quota.getZenmuxStatus().catch(() => null);
    setQuota(result ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const frameId = window.requestAnimationFrame(() => {
      fetchQuota();
    });
    const id = window.setInterval(fetchQuota, QUOTA_POLL_MS);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearInterval(id);
    };
  }, [isOpen, fetchQuota]);

  return { quota, loading };
}

// ── Progress bar ─────────────────────────────────────────────────────────

const QuotaBar: React.FC<{ label: string; pct: number }> = ({ label, pct }) => {
  const clamped = Math.min(Math.max(pct, 0), 100);
  const barColor =
    clamped >= 90
      ? "bg-danger-6"
      : clamped >= 70
        ? "bg-warning-6"
        : "bg-success-6";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-2">{label}</span>
        <span className="font-mono text-text-1">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-fill-3">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
};

// ── Panel ────────────────────────────────────────────────────────────────

interface PanelProps {
  isOpen: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
  panelPosition: { top?: number; bottom?: number; left?: number };
}

const SidebarQuotaMonitorPanel: React.FC<PanelProps> = ({
  isOpen,
  panelRef,
  panelPosition,
}) => {
  const { t } = useTranslation("sessions");
  const { quota, loading } = useQuotaData(isOpen);

  return (
    <>
      {isOpen &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.panelAnimated} border-stroke-1 fixed max-h-[400px] w-[280px] overflow-hidden rounded-xl border bg-bg-2 shadow-lg`}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
            }}
          >
            <div className="flex flex-col gap-3 p-3">
              <div className="text-[12px] font-semibold text-text-1">
                {t("quotaMonitor.title", "ZenMux Quota")}
              </div>
              {loading && !quota && (
                <div className="py-4 text-center text-[11px] text-text-3">
                  {t("quotaMonitor.loading", "Loading...")}
                </div>
              )}
              {quota && (
                <>
                  <QuotaBar
                    label={t("quotaMonitor.quota5h", "5-Hour Quota")}
                    pct={quota.quota5hPct}
                  />
                  <QuotaBar
                    label={t("quotaMonitor.quota7d", "7-Day Quota")}
                    pct={quota.quota7dPct}
                  />
                </>
              )}
              {!loading && !quota && (
                <div className="py-4 text-center text-[11px] text-text-3">
                  {t("quotaMonitor.unavailable", "Quota data unavailable")}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

// ── Button ───────────────────────────────────────────────────────────────

export const SidebarQuotaMonitorButton: React.FC = React.memo(() => {
  const { t } = useTranslation("sessions");
  const { isOpen, isPositioned, toggle, triggerRef, panelRef, panelPosition } =
    useDropdownEngine<HTMLDivElement>({
      placement: "top",
      align: "right",
      gap: DROPDOWN_PANEL.triggerGap,
    });
  const buttonActiveClassName = isOpen ? "text-primary-6" : "text-text-2";
  const triggerTitle = t("quotaMonitor.title", "ZenMux Quota");

  return (
    <>
      <div ref={triggerRef} title={triggerTitle}>
        <button
          type="button"
          className={`flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none p-0 transition-colors duration-150 ${
            isOpen ? "bg-bg-1" : "bg-transparent hover:bg-fill-2"
          }`}
          onClick={toggle}
          onMouseEnter={(event) => triggerIconAnimation(event.currentTarget)}
        >
          <HoverAnimatedIcon
            icon={Activity}
            iconName="activity"
            size={16}
            strokeWidth={2}
            className={buttonActiveClassName}
          />
        </button>
      </div>
      {isPositioned && (
        <SidebarQuotaMonitorPanel
          isOpen={isOpen}
          panelRef={panelRef}
          panelPosition={panelPosition}
        />
      )}
    </>
  );
});

SidebarQuotaMonitorButton.displayName = "SidebarQuotaMonitorButton";
