import type { TFunction } from "i18next";
import type React from "react";

import { formatAgentType } from "@src/assets/providers";
import type { AvailableAgent } from "@src/config/cliAgents";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import { AccountSourceBreadcrumb } from "../../Models/Table/AccountSourceBreadcrumb";
import { InlineCardColumnStack } from "../../shared/InlineCardPrimitives";

interface CliClientSubscriptionsContentProps {
  agent: AvailableAgent;
  accounts: KeyVaultAccount[];
  t: TFunction<"integrations">;
}

export function CliClientSubscriptionsContent({
  agent,
  accounts,
  t,
}: CliClientSubscriptionsContentProps) {
  const subscriptionAccounts = accounts.filter(
    (account) => account.modelType === agent.name
  );
  const compatibleApiLabels = agent.compatibleApiProviders.map((provider) =>
    formatAgentType(provider)
  );
  const valueOrEmpty = (values: string[]): React.ReactNode =>
    values.length > 0 ? (
      <span className="text-[12px] text-text-1">{values.join(", ")}</span>
    ) : (
      <span className="text-[12px] text-text-3">—</span>
    );

  return (
    <InlineCardColumnStack>
      {agent.nativeSubscriptionLabels.length > 0 && (
        <InfoRow label={t("cliPreview.nativeSubscription")} layout="vertical">
          <InlineCardColumnStack gap="compact">
            {agent.nativeSubscriptionLabels.map((label) => (
              <span key={label} className="text-[12px] text-text-1">
                {label}
              </span>
            ))}
          </InlineCardColumnStack>
        </InfoRow>
      )}
      <InfoRow label={t("cliPreview.compatibleApis")} layout="vertical">
        {valueOrEmpty(compatibleApiLabels)}
      </InfoRow>
      <InfoRow label={t("cliPreview.supportedProtocols")} layout="vertical">
        {valueOrEmpty(agent.supportedProtocols)}
      </InfoRow>
      <InfoRow label={t("cliPreview.addedSubscriptions")} layout="vertical">
        {subscriptionAccounts.length > 0 ? (
          <InlineCardColumnStack gap="compact">
            {subscriptionAccounts.map((account) => (
              <div
                key={account.id}
                className="flex h-9 min-h-9 items-center justify-between gap-3 rounded-md px-3 text-xs hover:bg-fill-1"
              >
                <div className="flex min-w-0 flex-1 items-center">
                  <AccountSourceBreadcrumb
                    modelType={account.modelType}
                    accountName={account.name}
                  />
                </div>
              </div>
            ))}
          </InlineCardColumnStack>
        ) : (
          <span className="text-[12px] text-text-3">
            {t("cliPreview.noSubscriptions")}
          </span>
        )}
      </InfoRow>
    </InlineCardColumnStack>
  );
}
