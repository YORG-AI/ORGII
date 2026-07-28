import type { TFunction } from "i18next";
import type React from "react";

import StatusDot from "@src/components/StatusDot";
import {
  type AvailableAgent,
  METHOD_DISPLAY_LABELS,
} from "@src/config/cliAgents";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import {
  InlineCardColumnStack,
  InlineCardSplit,
} from "../../shared/InlineCardPrimitives";
import { CliLaunchProfileSection } from "../Preview/CliLaunchProfileSection";

const ACP_SUPPORT_DOT_COLOR: Record<AvailableAgent["acpSupport"], string> = {
  native: "bg-success-6",
  adapter_backed: "bg-success-6",
  planned: "bg-warning-6",
  partial: "bg-warning-6",
  unavailable: "bg-text-4",
};

function StatusValue({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`text-[12px] font-medium ${active ? "text-success-6" : "text-text-3"}`}
    >
      {children}
    </span>
  );
}

export function CliClientStatusContent({
  agent,
  t,
}: {
  agent: AvailableAgent;
  t: TFunction<"integrations">;
}) {
  return (
    <InlineCardColumnStack>
      <CliLaunchProfileSection agentName={agent.name} />
      <div className="border-t border-border-2 pt-3" />
      <InlineCardSplit
        equalColumns
        left={
          <InlineCardColumnStack>
            <InfoRow label={t("cliPreview.installed")}>
              <StatusValue active={agent.installed}>
                {agent.installed
                  ? t("common:status.yes")
                  : t("common:status.no")}
              </StatusValue>
            </InfoRow>
            <InfoRow label={t("cliPreview.keys")}>
              <StatusValue active={agent.hasKeys}>
                {agent.hasKeys
                  ? t("cliPreview.configured")
                  : t("cliPreview.notConfigured")}
              </StatusValue>
            </InfoRow>
            {agent.installed && (
              <InfoRow label={t("cliPreview.installedVia")}>
                <span
                  className={`text-[12px] font-medium ${agent.installedVia ? "text-text-1" : "text-text-3"}`}
                >
                  {agent.installedVia
                    ? (METHOD_DISPLAY_LABELS[agent.installedVia] ??
                      agent.installedVia)
                    : t("common:status.na")}
                </span>
              </InfoRow>
            )}
          </InlineCardColumnStack>
        }
        right={
          <InlineCardColumnStack>
            <InfoRow label={t("cliPreview.acpSupport")}>
              <StatusDot
                color={ACP_SUPPORT_DOT_COLOR[agent.acpSupport]}
                size="inline"
                label={t(`cliPreview.acpSupportLabels.${agent.acpSupport}`)}
              />
            </InfoRow>
          </InlineCardColumnStack>
        }
      />
    </InlineCardColumnStack>
  );
}
