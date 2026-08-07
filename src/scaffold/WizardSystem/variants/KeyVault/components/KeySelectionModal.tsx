/**
 * KeySelectionModal
 *
 * Modal for choosing between multiple detected keys (e.g., OAuth + API key).
 * Uses design system tokens for consistent theming.
 */
import {
  AlertCircle,
  Check,
  CheckCircle,
  Key,
  KeyRound,
  X,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type { DetectedKey, ModelType } from "@src/api/types/keys";
import InlineAlert from "@src/components/InlineAlert";
import { PanelFooter } from "@src/modules/shared/layouts/blocks";

import { findEndpointByBaseUrl, useProviderConfig } from "../config";

interface KeySelectionModalProps {
  keys: DetectedKey[];
  /** Provider the detected keys belong to — supplies the endpoint labels. */
  agentType: ModelType;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  onConfirm: () => void;
  onClose: () => void;
}

const KeySelectionModal: React.FC<KeySelectionModalProps> = ({
  keys,
  agentType,
  selectedIndex,
  onSelectIndex,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation("integrations");
  const { config: providerConfig } = useProviderConfig(agentType);

  // Detected keys can come from different endpoints of the same provider
  // (OpenCode tiers, Zhipu regions and credential types). Name each target.
  const endpointLabel = (baseUrl?: string | null): string | null =>
    findEndpointByBaseUrl(providerConfig?.endpoints ?? [], baseUrl)?.label ??
    null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl bg-bg-2 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-2 p-4">
          <h3 className="text-[15px] font-semibold text-text-1">
            {t("keyVault.quickActions.multipleKeysFound")}
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-text-3 hover:bg-fill-2 hover:text-text-1"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4">
          <p className="mb-4 text-[13px] text-text-2">
            {t("keyVault.keysFoundForAgent", {
              count: keys.length,
            })}
          </p>

          <div className="space-y-3">
            {keys.map((cred, index) => (
              <button
                key={cred.id}
                onClick={() => cred.validated && onSelectIndex(index)}
                disabled={!cred.validated}
                className={`w-full rounded-lg border p-4 text-left transition-all ${
                  !cred.validated
                    ? "cursor-not-allowed border-dashed border-danger-3 bg-danger-1"
                    : selectedIndex === index
                      ? "border-primary-6 bg-primary-1"
                      : "border-border-2 bg-fill-2 hover:border-border-3 hover:bg-fill-1"
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Selection indicator */}
                  {cred.validated ? (
                    selectedIndex === index ? (
                      <Check
                        size={16}
                        className="mt-0.5 flex-shrink-0 text-primary-6"
                      />
                    ) : (
                      <div className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    )
                  ) : (
                    <AlertCircle
                      size={16}
                      className="mt-0.5 flex-shrink-0 text-danger-6"
                    />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {cred.auth_method === "oauth" ? (
                        <KeyRound
                          size={16}
                          className={
                            cred.validated ? "text-primary-6" : "text-danger-6"
                          }
                        />
                      ) : (
                        <Key
                          size={16}
                          className={
                            cred.validated ? "text-success-6" : "text-danger-6"
                          }
                        />
                      )}
                      <span
                        className={`text-[14px] font-medium ${cred.validated ? "text-text-1" : "text-danger-6"}`}
                      >
                        {cred.auth_method === "oauth"
                          ? "OAuth"
                          : t("keyVault.apiKeyLabel")}
                      </span>
                      {/* Validation status badge */}
                      {endpointLabel(cred.base_url) && (
                        <span className="rounded-full bg-fill-3 px-2 py-0.5 text-[10px] text-text-2">
                          {endpointLabel(cred.base_url)}
                        </span>
                      )}
                      {cred.validated === true ? (
                        <span className="flex items-center gap-1 rounded-full bg-success-1 px-2 py-0.5 text-[10px] text-success-6">
                          <CheckCircle size={10} />
                          {t("keyVault.quickActions.valid")}
                        </span>
                      ) : cred.validated === false ? (
                        <span className="flex items-center gap-1 rounded-full bg-danger-1 px-2 py-0.5 text-[10px] font-medium text-danger-6">
                          <AlertCircle size={10} />
                          {t("keyVault.quickActions.invalid")}
                        </span>
                      ) : null}
                    </div>
                    <div
                      className={`mt-1 text-[12px] ${cred.validated ? "text-text-3" : "text-danger-6/70"}`}
                    >
                      {cred.auth_method === "oauth" ? (
                        <>
                          {cred.quota_info?.plan_type && (
                            <span className="mr-2">
                              {t("keyVault.quickActions.planType", {
                                plan: cred.quota_info.plan_type,
                              })}
                            </span>
                          )}
                          {typeof cred.quota_info?.remaining_percentage ===
                            "number" && (
                            <span className="text-success-6">
                              {t("keyVault.quickActions.percentRemaining", {
                                percent: Math.round(
                                  cred.quota_info.remaining_percentage
                                ),
                              })}
                            </span>
                          )}
                          {!cred.quota_info?.plan_type &&
                            !cred.quota_info?.remaining_percentage && (
                              <span>{t("keyVault.fromCodexAuthLogin")}</span>
                            )}
                        </>
                      ) : (
                        <>
                          {cred.api_key && (
                            <span>
                              {cred.api_key.slice(0, 8)}...
                              {cred.api_key.slice(-4)}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    {cred.validated === false && cred.validation_message && (
                      <InlineAlert type="danger">
                        {cred.validation_message}
                      </InlineAlert>
                    )}
                    {cred.validated &&
                      cred.available_models &&
                      cred.available_models.length > 0 && (
                        <div className="mt-2 text-[11px] text-text-3">
                          {t("keyVault.quickActions.modelsAvailable", {
                            count: cred.available_models.length,
                          })}
                        </div>
                      )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <PanelFooter
          secondaryActions={[
            { label: t("common:actions.cancel"), onClick: onClose },
          ]}
          primaryAction={{
            label: t("keyVault.quickActions.useSelected"),
            onClick: onConfirm,
            disabled: !keys[selectedIndex]?.validated,
          }}
        />
      </div>
    </div>
  );
};

export default KeySelectionModal;
