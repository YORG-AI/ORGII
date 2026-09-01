/**
 * Provider + variant selection option builders for ApiSetup.
 *
 * These functions take already-loaded data from useProviderRegistry hook.
 * They do NOT fetch data themselves — the caller must provide the data.
 */
import type { TFunction } from "i18next";
import React from "react";

import ModelIcon from "@src/components/ModelIcon";
import { type IconProvider } from "@src/components/ModelIcon/config";
import type { SelectOption } from "@src/components/Select";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { Calendar01Icon, CogIcon, HugeiconsIcon, Key02Icon } from "@src/icons";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives";

import type {
  ProviderGroup,
  UnifiedProvider,
  UnifiedProviderVariant,
} from "../config";

/** Custom filter for JSX-labelled options — searches against extra.searchText */
export function filterOptionBySearchText(
  inputValue: string,
  option: SelectOption
): boolean {
  const searchText =
    (option.extra as { searchText?: string } | undefined)?.searchText ??
    String(option.value);
  return searchText.toLowerCase().includes(inputValue.toLowerCase());
}

export function resolveVariantLabel(
  variant: UnifiedProviderVariant,
  provider: UnifiedProvider | undefined,
  t: TFunction
): string {
  if (!provider) return variant.label;
  if (variant.mode === "api_key") {
    return t("wizard.variantApiKey", "API Key");
  }
  return variant.label;
}

function variantIconNode(
  variant: UnifiedProviderVariant,
  size: number
): React.ReactNode {
  if (variant.mode === "api_key") {
    return (
      <HugeiconsIcon
        icon={Key02Icon}
        data-icon="key-round"
        size={size}
        className="shrink-0 text-text-3"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={Calendar01Icon}
      data-icon="calendar"
      size={size}
      className="shrink-0 text-text-3"
    />
  );
}

interface ProviderGridOptionGroup {
  group: ProviderGroup;
  options: SelectionGridOption[];
}

/** Icon source for a provider — a brand logo, or a glyph for brand-less tiles. */
type ProviderIconSource = Pick<UnifiedProvider, "iconElement" | "iconProvider">;

/**
 * The "Custom" tiles (local endpoint, cloud gateway) stand for whatever the
 * user points them at, so they carry a cog glyph instead of a brand logo.
 */
function providerUsesGlyphIcon(provider: ProviderIconSource): boolean {
  return provider.iconElement === "cog";
}

/** Single place any surface renders a provider's icon. */
function providerIconNode(
  provider: ProviderIconSource,
  size: number
): React.ReactNode {
  if (providerUsesGlyphIcon(provider)) {
    return (
      <HugeiconsIcon
        icon={CogIcon}
        data-icon="cog"
        size={size}
        className="shrink-0 text-text-3"
      />
    );
  }
  return (
    <ModelIcon provider={provider.iconProvider as IconProvider} size={size} />
  );
}

function buildProviderGridOption(
  provider: UnifiedProvider
): SelectionGridOption {
  return {
    key: provider.key,
    label: provider.label,
    iconElement: providerIconNode(provider, 18),
    // Brand logos keep their own colours; the cog glyph inherits text colour.
    iconPreserveColor: !providerUsesGlyphIcon(provider),
  };
}

export function buildProviderGridOptionGroups(
  providers: UnifiedProvider[]
): ProviderGridOptionGroup[] {
  const groups: ProviderGridOptionGroup[] = [];
  for (const group of ["cloud", "local"] as ProviderGroup[]) {
    const options = providers
      .filter((provider) => provider.group === group)
      .map(buildProviderGridOption);
    if (options.length > 0) groups.push({ group, options });
  }
  return groups;
}

export function buildProviderSelectOptions(
  providers: UnifiedProvider[]
): SelectOption[] {
  return providers.map((provider) => {
    const labelNode = (
      <span className="flex items-center gap-2">
        {providerIconNode(provider, 16)}
        {provider.label}
      </span>
    );
    return {
      value: provider.key,
      label: labelNode,
      triggerLabel: labelNode,
      extra: { searchText: provider.label },
    };
  });
}

export function buildVariantGridOptions(
  selectedProvider: UnifiedProvider | undefined,
  t: TFunction
): SelectionGridOption[] {
  if (!selectedProvider || selectedProvider.variants.length <= 1) return [];
  return selectedProvider.variants.map((variant) => {
    const label = resolveVariantLabel(variant, selectedProvider, t);
    return {
      key: variant.modelType,
      label,
      icon: variant.mode === "api_key" ? Key02Icon : Calendar01Icon,
    };
  });
}

export function buildVariantSelectOptions(
  selectedProvider: UnifiedProvider | undefined,
  t: TFunction
): SelectOption[] {
  if (!selectedProvider || selectedProvider.variants.length <= 1) return [];
  return selectedProvider.variants.map((variant) => {
    const label = resolveVariantLabel(variant, selectedProvider, t);
    const icon = variantIconNode(variant, 16);
    const labelNode = (
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
    );
    return {
      value: variant.modelType,
      label: labelNode,
      triggerLabel: labelNode,
      extra: { searchText: label },
    };
  });
}

/** Provider filter for Keys table — one row per brand (e.g. OpenAI covers API + Codex). */
export function buildBrandProviderFilterOptions(
  accounts: KeyVaultAccount[],
  unifiedProviders: UnifiedProvider[],
  modelTypeToProviderKey: Record<string, string>,
  t: TFunction
): SelectOption[] {
  const brandKeysWithAccounts = new Set<string>();
  for (const account of accounts) {
    const brandKey =
      modelTypeToProviderKey[account.modelType] ?? account.modelType;
    brandKeysWithAccounts.add(brandKey);
  }

  const providers = unifiedProviders
    .filter((provider) => brandKeysWithAccounts.has(provider.key))
    .sort((providerA, providerB) =>
      providerA.label.localeCompare(providerB.label)
    );

  return [
    {
      value: "all",
      label: t("keyVault.filterAllProviders"),
    },
    ...providers.map((provider) => {
      const labelNode = (
        <span className="flex items-center gap-2">
          {providerIconNode(provider, 16)}
          {provider.label}
        </span>
      );
      return {
        value: provider.key,
        label: labelNode,
        triggerLabel: labelNode,
        extra: { searchText: provider.label },
      };
    }),
  ];
}

export function accountMatchesBrandFilter(
  account: KeyVaultAccount,
  brandKey: string,
  modelTypeToProviderKey: Record<string, string>
): boolean {
  return (
    (modelTypeToProviderKey[account.modelType] ?? account.modelType) ===
    brandKey
  );
}
