import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadAvailableAgents } from "@src/api/services/availableAgents";
import { rpc } from "@src/api/tauri/rpc";
import type {
  AvailableAgent,
  AvailableApiProvider,
} from "@src/api/tauri/rpc/schemas/validation";
import { isApiKeyProvider } from "@src/assets/providers";
import ModelIcon from "@src/components/ModelIcon";
import StatusDot from "@src/components/StatusDot";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { createLogger } from "@src/hooks/logger";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

const logger = createLogger("AccountCompatibilitySection");

interface AccountCompatibilitySectionProps {
  account: KeyVaultAccount;
}

export const AccountCompatibilitySection: React.FC<
  AccountCompatibilitySectionProps
> = ({ account }) => {
  const { t } = useTranslation("integrations");
  const isApiKey = isApiKeyProvider(account.modelType);

  const [providerInfo, setProviderInfo] = useState<AvailableApiProvider | null>(
    null
  );
  const [agentInfo, setAgentInfo] = useState<AvailableAgent | null>(null);

  const supportsOrgiiAgents = isApiKey
    ? Boolean(providerInfo?.supportsRustAgents)
    : account.supportsRustAgents === true;
  const supportsCliAgents = isApiKey
    ? (providerInfo?.compatibleCliAgents.length ?? 0) > 0
    : account.canLaunchCli === true;

  useEffect(() => {
    let cancelled = false;

    if (isApiKey) {
      rpc.validation
        .getAvailableApiProviders()
        .then((providers) => {
          if (cancelled) return;
          const match = providers.find(
            (prov) => prov.name === account.modelType
          );
          setProviderInfo(match ?? null);
          setAgentInfo(null);
        })
        .catch((error) => {
          logger.error("Failed to load API provider compatibility", error);
        });
    } else {
      loadAvailableAgents()
        .then((agents) => {
          if (cancelled) return;
          const match = agents.find(
            (agent) => agent.name === account.modelType
          );
          setAgentInfo(match ?? null);
          setProviderInfo(null);
        })
        .catch((error) => {
          logger.error("Failed to load CLI agent compatibility", error);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [account.modelType, isApiKey]);

  if (!providerInfo && !agentInfo) {
    return (
      <span className="text-xs text-text-3">
        {t("keyVault.info.noCliAgentSupport")}
      </span>
    );
  }

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="key-vault-agent-compatibility"
    >
      <InfoRow label={t("keyVault.info.supportOrgiiAgents")}>
        <div
          data-supported={supportsOrgiiAgents}
          data-testid="key-vault-orgii-agent-compatibility"
        >
          <StatusDot
            color={supportsOrgiiAgents ? "bg-success-6" : "bg-text-4"}
            size="inline"
            label={
              supportsOrgiiAgents
                ? t("common:status.supported")
                : t("common:status.notSupported")
            }
          />
        </div>
      </InfoRow>
      {providerInfo ? (
        <InfoRow label={t("keyVault.info.supportCliAgents")}>
          {providerInfo.compatibleCliAgents.length > 0 ? (
            <div
              className="flex flex-wrap items-center justify-end gap-1.5"
              data-supported={supportsCliAgents}
              data-testid="key-vault-cli-agent-compatibility"
            >
              {providerInfo.compatibleCliAgents
                .filter((cli): cli is string => Boolean(cli))
                .map((cli) => (
                  <ModelIcon key={cli} agentType={cli} size="small" />
                ))}
            </div>
          ) : (
            <div
              data-supported={supportsCliAgents}
              data-testid="key-vault-cli-agent-compatibility"
            >
              <StatusDot
                color="bg-text-4"
                size="inline"
                label={t("common:status.notSupported")}
              />
            </div>
          )}
        </InfoRow>
      ) : null}
      {agentInfo ? (
        <InfoRow label={t("keyVault.info.supportCliAgents")}>
          {supportsCliAgents ? (
            <div
              className="flex flex-wrap items-center justify-end gap-1.5"
              data-supported={supportsCliAgents}
              data-testid="key-vault-cli-agent-compatibility"
            >
              <ModelIcon agentType={agentInfo.name} size="small" />
            </div>
          ) : (
            <div
              data-supported={supportsCliAgents}
              data-testid="key-vault-cli-agent-compatibility"
            >
              <StatusDot
                color="bg-text-4"
                size="inline"
                label={t("common:status.notSupported")}
              />
            </div>
          )}
        </InfoRow>
      ) : null}
    </div>
  );
};
