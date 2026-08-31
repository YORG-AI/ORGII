/**
 * ProviderSelector — Reusable provider selection grid.
 *
 * Wraps SectionContainer + SectionRow + SelectionGrid for picking an API provider.
 * Used by KeyVaultWizard (ApiSetup) and ListingWizard.
 *
 * Supports two modes:
 * - Grid mode (default): Shows provider cards for initial selection
 * - Compact mode (selectedProviderKey set): Shows a Select dropdown to switch
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import InlineAlert from "@src/components/InlineAlert";
import Select from "@src/components/Select";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";
import {
  buildProviderSelectOptions,
  filterOptionBySearchText,
  providerIconNode,
  providerUsesGlyphIcon,
} from "@src/scaffold/WizardSystem/variants/KeyVault/components/providerOptions";
import {
  type UnifiedProvider,
  useProviderRegistry,
} from "@src/scaffold/WizardSystem/variants/KeyVault/config";

// ============================================
// Types
// ============================================

export interface ProviderSelectorProps {
  /** Currently selected provider key (null = none selected yet) */
  selectedProviderKey: string | null;
  /** Callback when a provider is selected */
  onSelect: (providerKey: string) => void;
  /** Callback to clear provider selection (compact mode) */
  onClear?: () => void;
  /** Filter providers (e.g. only API key providers) */
  filter?: (provider: UnifiedProvider) => boolean;
  /** Error message to display above the grid */
  error?: string;
  /** Whether to show compact (Select dropdown) when a provider is already selected */
  compactWhenSelected?: boolean;
}

// ============================================
// Component
// ============================================

const ProviderSelector: React.FC<ProviderSelectorProps> = ({
  selectedProviderKey,
  onSelect,
  onClear,
  filter,
  error,
  compactWhenSelected = false,
}) => {
  const { t } = useTranslation("integrations");
  const { unifiedProviders } = useProviderRegistry();

  const filteredProviders = useMemo(
    () => (filter ? unifiedProviders.filter(filter) : unifiedProviders),
    [unifiedProviders, filter]
  );

  const gridOptions = useMemo<SelectionGridOption[]>(
    () =>
      filteredProviders.map((provider) => ({
        key: provider.key,
        label: provider.label,
        iconElement: providerIconNode(provider, 18),
        iconPreserveColor: !providerUsesGlyphIcon(provider),
      })),
    [filteredProviders]
  );

  const selectOptions = useMemo(
    () => buildProviderSelectOptions(filteredProviders),
    [filteredProviders]
  );

  const showCompact = compactWhenSelected && !!selectedProviderKey;

  return (
    <>
      <SectionContainer>
        {showCompact ? (
          <SectionRow
            label={t("wizard.pickProvider", "Provider")}
            description={t("wizard.pickProviderDesc", "Select a provider")}
            required
          >
            <Select
              value={selectedProviderKey}
              options={selectOptions}
              allowClear
              showSearch
              filterOption={filterOptionBySearchText}
              onChange={(val) => onSelect(val as string)}
              onClear={onClear}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
        ) : (
          <SectionRow
            label={t("wizard.pickProvider", "Provider")}
            description={t("wizard.pickProviderDesc", "Select a provider")}
            layout="vertical"
            required
          >
            <SelectionGrid
              options={gridOptions}
              selected={selectedProviderKey}
              cardVariant="subtle"
              onSelect={onSelect}
            />
          </SectionRow>
        )}
      </SectionContainer>
      {error && !showCompact && (
        <div className="mt-3">
          <InlineAlert type="danger">{error}</InlineAlert>
        </div>
      )}
    </>
  );
};

export default ProviderSelector;
