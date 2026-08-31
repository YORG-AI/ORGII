/**
 * OAuthSetup Component
 *
 * Setup UI for OAuth-based agents (Kiro) - auto-detect from local CLI storage
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { CLI_AGENT } from "@src/api/types/keys";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import type { OAuthSetupProps } from "./types";

const OAuthSetup: React.FC<OAuthSetupProps> = ({
  data,
  onChange: _onChange,
  tokenDetected,
  detectingToken,
  tokenError,
  onDetectToken,
}) => {
  const { t } = useTranslation("integrations");

  const isKiro = data.agent_type === CLI_AGENT.KIRO;
  const agentName = isKiro ? "Kiro" : "this agent";
  const cliCommand = isKiro ? "kiro-cli login" : "CLI login";

  return (
    <div className={SECTION_GAP_CLASSES}>
      <SectionContainer>
        <SectionRow
          label={t("keyVault.authentication")}
          description={t("keyVault.oauthHint", {
            agent: agentName,
            command: cliCommand,
          })}
        />
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={
            tokenDetected
              ? t("keyVault.oauthTokenDetected")
              : t("keyVault.detectOAuthToken")
          }
          description={
            isKiro
              ? t("keyVault.readFromKiroCliStorage")
              : t("keyVault.readFromCliStorage")
          }
          required
        >
          <Button
            variant={tokenDetected ? "success" : "primary"}
            appearance={tokenDetected ? "outline" : undefined}
            size="default"
            loading={detectingToken}
            disabled={detectingToken}
            onClick={onDetectToken}
            className="h-8 min-h-8"
          >
            {tokenDetected
              ? `✓ ${t("keyVault.detected")}`
              : t("keyVault.detect")}
          </Button>
        </SectionRow>
      </SectionContainer>
      {tokenError && (
        <div className="mt-3">
          <InlineAlert type="danger">{tokenError}</InlineAlert>
        </div>
      )}
    </div>
  );
};

export { OAuthSetup };
