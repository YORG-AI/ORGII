import { Network } from "lucide-react";
import { type FC, useEffect, useMemo, useState } from "react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  FieldRow,
  Option,
  SearchableDropdown,
} from "@src/components/PropertyField/PropertyFieldEditable";
import type { SelectOption } from "@src/components/Select";

export interface ProjectOrganizationFieldProps {
  label?: string;
  value: string;
  valueLabel: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  searchPlaceholder?: string;
  dataTestId?: string;
}

function getOptionLabel(option: SelectOption): string {
  const label = option.triggerLabel ?? option.label;
  return typeof label === "string" || typeof label === "number"
    ? String(label)
    : String(option.value);
}

/** Organization field using the same row and dropdown primitives as Status. */
const ProjectOrganizationField: FC<ProjectOrganizationFieldProps> = ({
  label,
  value,
  valueLabel,
  options,
  onChange,
  disabled = false,
  searchPlaceholder,
  dataTestId,
}) => {
  const [open, setOpen] = useState(false);
  const networkIcon = <Network size={DROPDOWN_ITEM.iconSize} />;

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("[data-project-organization-field]")) return;
      if (target.closest("[data-property-dropdown]")) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const organizationOptions = useMemo(
    () =>
      options.map((option) => ({
        ...option,
        displayLabel: getOptionLabel(option),
      })),
    [options]
  );

  return (
    <div
      className="relative flex min-h-[36px] w-full items-center"
      data-project-organization-field
      data-testid={dataTestId}
    >
      <FieldRow
        icon={networkIcon}
        label={label}
        value={valueLabel}
        isSelected
        isActive={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      />
      {open ? (
        <SearchableDropdown
          placeholder={searchPlaceholder}
          widthMode="match-parent"
          align="left"
        >
          {(searchQuery) => {
            const normalizedQuery = searchQuery.trim().toLowerCase();
            return organizationOptions
              .filter(
                (option) =>
                  !normalizedQuery ||
                  option.displayLabel.toLowerCase().includes(normalizedQuery)
              )
              .map((option) => (
                <Option
                  key={option.value}
                  icon={networkIcon}
                  label={option.displayLabel}
                  isSelected={String(option.value) === value}
                  disabled={option.disabled}
                  dataTestId={option.dataTestId}
                  onClick={() => {
                    onChange(String(option.value));
                    setOpen(false);
                  }}
                />
              ));
          }}
        </SearchableDropdown>
      ) : null}
    </div>
  );
};

ProjectOrganizationField.displayName = "ProjectOrganizationField";

export default ProjectOrganizationField;
