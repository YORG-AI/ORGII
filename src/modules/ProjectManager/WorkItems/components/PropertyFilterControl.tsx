import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type {
  PropertyDefinition,
  ScopePropertyValue,
} from "@src/api/http/project";
import Select from "@src/components/Select";
import { FilterIcon, HugeiconsIcon } from "@src/icons";
import type { Person } from "@src/types/core/shared";

import {
  PROPERTY_FILTER_NONE_VALUE,
  type WorkItemPropertyFilter,
  propertyFilterOptions,
} from "../propertyViewModel";

interface PropertyFilterControlProps {
  definitions: PropertyDefinition[];
  values: ScopePropertyValue[];
  members: Person[];
  selectedPropertyId: string | null;
  filter: WorkItemPropertyFilter | null;
  onSelectedPropertyIdChange: (propertyId: string | null) => void;
  onFilterChange: (filter: WorkItemPropertyFilter | null) => void;
}

export const PropertyFilterControl: React.FC<PropertyFilterControlProps> = ({
  definitions,
  values,
  members,
  selectedPropertyId,
  filter,
  onSelectedPropertyIdChange,
  onFilterChange,
}) => {
  const { t } = useTranslation("projects");
  const selectedDefinition = definitions.find(
    (definition) => definition.id === selectedPropertyId
  );
  const definitionOptions = useMemo(
    () =>
      definitions.map((definition) => ({
        value: definition.id,
        label: definition.name,
      })),
    [definitions]
  );
  const valueOptions = useMemo(
    () =>
      selectedDefinition
        ? propertyFilterOptions(selectedDefinition, values, members).map(
            (option) => ({
              ...option,
              label:
                option.value === PROPERTY_FILTER_NONE_VALUE
                  ? t("workItems.properties.noValue", {
                      defaultValue: "No value",
                    })
                  : option.label,
            })
          )
        : [],
    [members, selectedDefinition, t, values]
  );

  if (definitions.length === 0) return null;

  return (
    <div
      className="flex min-w-0 items-center gap-1"
      data-testid="work-items-property-filter"
    >
      <Select
        value={selectedPropertyId ?? undefined}
        options={definitionOptions}
        onChange={(value) => {
          const propertyId = String(value);
          onSelectedPropertyIdChange(propertyId);
          if (filter?.propertyId !== propertyId) onFilterChange(null);
        }}
        onClear={() => {
          onSelectedPropertyIdChange(null);
          onFilterChange(null);
        }}
        allowClear
        showSearch
        appearance="ghost"
        size="small"
        prefix={
          <HugeiconsIcon icon={FilterIcon} data-icon="filter" size={13} />
        }
        placeholder={t("workItems.properties.filter", {
          defaultValue: "Property filter",
        })}
        ariaLabel={t("workItems.properties.filter", {
          defaultValue: "Property filter",
        })}
        dataTestId="work-items-property-filter-definition"
      />
      {selectedDefinition ? (
        <Select
          value={
            filter?.propertyId === selectedDefinition.id
              ? filter.valueToken
              : undefined
          }
          options={valueOptions}
          onChange={(value) =>
            onFilterChange({
              propertyId: selectedDefinition.id,
              valueToken: String(value),
            })
          }
          onClear={() => onFilterChange(null)}
          allowClear
          showSearch
          appearance="ghost"
          size="small"
          placeholder={t("workItems.properties.filterValue", {
            defaultValue: "Value",
          })}
          ariaLabel={t("workItems.properties.filterValue", {
            defaultValue: "Property filter value",
          })}
          dataTestId="work-items-property-filter-value"
        />
      ) : null}
    </div>
  );
};

export default PropertyFilterControl;
