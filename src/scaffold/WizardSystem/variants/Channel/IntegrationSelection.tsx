import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import IntegrationIcon from "@src/components/IntegrationIcon";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { HugeiconsIcon, Search01Icon } from "@src/icons";
import {
  COMING_SOON_CHANNEL_TYPES,
  LIVE_CHANNEL_TYPES,
} from "@src/modules/MainApp/Integrations/Connections/Channels/config";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives";

import {
  PROJECT_ADAPTER_TYPES,
  type WizardCategory,
} from "./channelWizardTypes";

type TypeOptionGroup = {
  category: WizardCategory;
  label: string;
  options: SelectionGridOption[];
  selectOptions: SelectOption[];
  selectable: boolean;
};

function filterOptionBySearchText(
  inputValue: string,
  option: SelectOption
): boolean {
  const searchText =
    (option.extra as { searchText?: string } | undefined)?.searchText ??
    String(option.value);
  return searchText.toLowerCase().includes(inputValue.toLowerCase());
}

function toSelectOptions(options: SelectionGridOption[]): SelectOption[] {
  return options.map((option) => {
    const label = (
      <span className="flex items-center gap-2">
        {option.iconElement}
        {option.label}
      </span>
    );
    return {
      value: option.key,
      label,
      triggerLabel: label,
      extra: { searchText: option.label },
    };
  });
}

interface IntegrationSelectionProps {
  category: WizardCategory | null;
  selectedType: string | null;
  onSelectType: (category: WizardCategory, type: string) => void;
  onClearSelection: () => void;
  accountName: string;
  accountNameBase: string;
  onAccountNameChange: (name: string) => void;
  errors: { type?: string; name?: string };
  /** Live duplicate-name flag — true while the typed name collides. */
  isDuplicateName?: boolean;
  totalSteps: number;
  actions: React.ReactNode;
  /** Cancel handler — forwarded to `WizardStepLayout` to render the
   * footer Cancel button (replaces the WizardShell X close). */
  onCancel?: () => void;
  footerLeft?: React.ReactNode;
  channelContent?: React.ReactNode;
  projectContent?: React.ReactNode;
  gitContent?: React.ReactNode;
}

const IntegrationSelection: React.FC<IntegrationSelectionProps> = ({
  category,
  selectedType,
  onSelectType,
  onClearSelection,
  accountName,
  accountNameBase,
  onAccountNameChange,
  errors,
  isDuplicateName = false,
  totalSteps,
  actions,
  onCancel,
  footerLeft,
  channelContent,
  projectContent,
  gitContent,
}) => {
  const { t } = useTranslation("integrations");
  const [connectionSearch, setConnectionSearch] = useState("");
  const typeGroups: TypeOptionGroup[] = useMemo(() => {
    const channelOptions = LIVE_CHANNEL_TYPES.map((channel) => ({
      key: channel.type,
      label: t(channel.labelKey),
      iconElement: <IntegrationIcon type={channel.type} size={18} />,
    }));
    const comingSoonChannelOptions = COMING_SOON_CHANNEL_TYPES.map(
      (channel) => ({
        key: channel.type,
        label: t(channel.labelKey),
        iconElement: <IntegrationIcon type={channel.type} size={18} />,
        disabled: true,
      })
    );
    const projectOptions = PROJECT_ADAPTER_TYPES.map((adapter) => ({
      key: adapter.type,
      label: t(
        adapter.labelKey,
        adapter.type === "github" ? "GitHub" : adapter.type
      ),
      iconElement: <IntegrationIcon type={adapter.type} size={18} />,
    }));

    return [
      {
        category: "channels",
        label: t("categories.channels"),
        options: channelOptions,
        selectOptions: toSelectOptions(channelOptions),
        selectable: true,
      },
      {
        category: "channels",
        label: `${t("categories.channels")} (${t("modelsTabs.comingSoon")})`,
        options: comingSoonChannelOptions,
        selectOptions: [],
        selectable: false,
      },
      {
        category: "projects",
        label: `${t("categories.git")} & ${t("categories.projects")}`,
        options: projectOptions,
        selectOptions: toSelectOptions(projectOptions),
        selectable: true,
      },
    ];
  }, [t]);

  const flatSelectOptions = useMemo(
    () => typeGroups.flatMap((group) => group.selectOptions),
    [typeGroups]
  );

  const typeLookup = useMemo(() => {
    const lookup = new Map<string, WizardCategory>();
    for (const group of typeGroups) {
      if (!group.selectable) continue;
      for (const option of group.options) {
        lookup.set(option.key, group.category);
      }
    }
    return lookup;
  }, [typeGroups]);

  const filteredTypeGroups = useMemo(() => {
    const query = connectionSearch.trim().toLowerCase();
    if (!query) return typeGroups;
    return typeGroups
      .map((group) => {
        const options = group.options.filter((option) =>
          option.label.toLowerCase().includes(query)
        );
        return {
          ...group,
          options,
          selectOptions: group.selectable ? toSelectOptions(options) : [],
        };
      })
      .filter((group) => group.options.length > 0);
  }, [connectionSearch, typeGroups]);

  const [accountNameTouched, setAccountNameTouched] = useState(false);

  const accountNameError =
    accountNameTouched && isDuplicateName
      ? t("integrations.accountNameDuplicate")
      : errors.name;

  const accountNameContent = selectedType ? (
    <SectionContainer>
      <SectionRow
        label={t("keyVault.accountName")}
        description={t("keyVault.accountNameDesc", {
          provider: accountNameBase,
        })}
      >
        <Input
          value={accountName}
          onChange={(value) => {
            onAccountNameChange(value);
            if (accountNameTouched) setAccountNameTouched(false);
          }}
          onBlur={() => {
            if (accountName.trim()) setAccountNameTouched(true);
          }}
          placeholder={t("keyVault.accountNamePlaceholder", {
            provider: accountNameBase,
          })}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          style={SECTION_CONTROL_STYLE}
          errorMessage={accountNameError}
          errorPlacement="left"
        />
      </SectionRow>
    </SectionContainer>
  ) : null;

  const selectedSetupContent = selectedType ? (
    <div className={SECTION_GAP_CLASSES}>
      {accountNameContent}
      {category === "channels" && channelContent}
      {projectContent}
      {gitContent}
    </div>
  ) : null;

  return (
    <WizardStepLayout
      currentStep={1}
      totalSteps={totalSteps}
      footerLeft={footerLeft}
      actions={actions}
      onCancel={onCancel}
      hideStepIndicator
      contentWidthFooter
    >
      <div className={SECTION_GAP_CLASSES}>
        <SectionContainer>
          <SectionRow
            label={t("connectionsTabs.connections")}
            description={t("keyVault.selectorDesc")}
            layout={selectedType ? "horizontal" : "vertical"}
            required
          >
            {selectedType ? (
              <Select
                value={selectedType}
                options={flatSelectOptions}
                allowClear
                showSearch
                filterOption={filterOptionBySearchText}
                onChange={(value) => {
                  if (!value) return;
                  const nextType = String(value);
                  const nextCategory = typeLookup.get(nextType);
                  if (nextCategory) {
                    onSelectType(nextCategory, nextType);
                  }
                }}
                onClear={onClearSelection}
                style={SECTION_CONTROL_STYLE}
              />
            ) : (
              <div className="flex flex-col gap-3">
                <Input
                  value={connectionSearch}
                  onChange={setConnectionSearch}
                  placeholder={t("integrations.searchPlaceholder")}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  prefix={
                    <HugeiconsIcon
                      icon={Search01Icon}
                      data-icon="search"
                      size={14}
                    />
                  }
                  style={{ width: "100%" }}
                />
                <div className="flex flex-col gap-3">
                  {filteredTypeGroups.map((group) => (
                    <div
                      key={`${group.category}:${group.label}`}
                      className="flex flex-col gap-2"
                    >
                      <div className="text-[12px] font-medium text-text-2">
                        {group.label}
                      </div>
                      <SelectionGrid
                        options={group.options}
                        selected={null}
                        cardVariant="subtle"
                        onSelect={(type) => {
                          if (!group.selectable) return;
                          onSelectType(group.category, type);
                        }}
                      />
                    </div>
                  ))}
                </div>
                {errors.type && (
                  <p className="text-[12px] text-danger-6">{errors.type}</p>
                )}
              </div>
            )}
          </SectionRow>
        </SectionContainer>

        {selectedSetupContent}
      </div>
    </WizardStepLayout>
  );
};

export default IntegrationSelection;
