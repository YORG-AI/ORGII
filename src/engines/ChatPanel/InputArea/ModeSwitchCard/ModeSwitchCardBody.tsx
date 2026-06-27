import { ArrowLeftRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  ChatStatusSegmentedBar,
  ChatStatusTwoLineContent,
} from "@src/engines/ChatPanel/components/ChatStatusBanners";

import { MODE_LABELS } from "./useModeSwitchActions";

const MODE_SWITCH_AUTO_SKIP_TIMEOUT_MS = 300_000;

function getAutoSkipRemaining(createdAt: string | undefined, nowMs: number) {
  if (!createdAt) return null;
  const startedAt = Date.parse(createdAt);
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(
    0,
    Math.ceil((startedAt + MODE_SWITCH_AUTO_SKIP_TIMEOUT_MS - nowMs) / 1000)
  );
}

export interface ModeSwitchCardBodyProps {
  targetMode: string;
  reason: string;
  createdAt?: string;
  onSwitch: () => void;
  onSkip: () => void;
  collapsed?: boolean;
  onCollapse?: () => void;
}

export function ModeSwitchCardBody({
  targetMode,
  reason,
  createdAt,
  onSwitch,
  onSkip,
  collapsed = false,
}: ModeSwitchCardBodyProps) {
  const { t } = useTranslation("sessions");
  const modeLabel = MODE_LABELS[targetMode] ?? targetMode;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!createdAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [createdAt]);

  const autoSkipRemaining = getAutoSkipRemaining(createdAt, nowMs);

  if (collapsed) return null;

  return (
    <ChatStatusSegmentedBar
      testId="mode-switch-card"
      data-target-mode={targetMode}
      segments={[
        {
          key: "message",
          className: "flex-1",
          content: (
            <ChatStatusTwoLineContent
              title={t("tools.modeSwitch.label", { mode: modeLabel })}
              description={reason || t("tools.modeSwitch.noReason")}
            />
          ),
        },
        {
          key: "actions",
          className: "shrink-0 px-0",
          content: (
            <span className="inline-flex items-center gap-1">
              {autoSkipRemaining !== null &&
                autoSkipRemaining !== undefined && (
                  <span
                    className="chat-block-xs tabular-nums text-text-3"
                    data-testid="mode-switch-auto-skip-countdown"
                    data-auto-skip-remaining={autoSkipRemaining}
                  >
                    {t("chat.autoSkipCountdown", {
                      seconds: autoSkipRemaining,
                    })}
                  </span>
                )}
              <Button
                variant="tertiary"
                shape="round"
                size="mini"
                onClick={onSkip}
                data-testid="mode-switch-skip"
              >
                {t("tools.modeSwitch.skip")}
              </Button>
              <Button
                variant="primary"
                shape="round"
                size="mini"
                onClick={onSwitch}
                data-testid="mode-switch-confirm"
                icon={<ArrowLeftRight size={12} strokeWidth={2} />}
              >
                {t("tools.modeSwitch.switch")}
              </Button>
            </span>
          ),
        },
      ]}
    />
  );
}

ModeSwitchCardBody.displayName = "ModeSwitchCardBody";
