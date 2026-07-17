import { Plus, Settings2 } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import Select, { type SelectOption } from "@src/components/Select";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";

interface SidebarOrgSelectorProps {
  value: string;
  options: SelectOption[];
  addOrgLabel: string;
  /** Label for the manage-org entry; rendered only with `onManageOrg`. */
  manageLabel?: string;
  onChange: (orgId: string) => void;
  onAddOrg: () => void;
  /**
   * Explicit management entry for the ACTIVE org (cloud orgs only —
   * selector picks switch scope, management needs its own entry).
   */
  onManageOrg?: () => void;
}

const SidebarOrgSelector: React.FC<SidebarOrgSelectorProps> = React.memo(
  ({
    value,
    options,
    addOrgLabel,
    manageLabel,
    onChange,
    onAddOrg,
    onManageOrg,
  }) => {
    const { t } = useTranslation("navigation");
    const [menuOpen, setMenuOpen] = useState(false);

    const handleChange = useCallback(
      (nextValue: string | number | (string | number)[]) => {
        if (Array.isArray(nextValue)) return;
        onChange(String(nextValue));
      },
      [onChange]
    );

    const handleAddOrg = useCallback(() => {
      setMenuOpen(false);
      onAddOrg();
    }, [onAddOrg]);

    const handleManageOrg = useCallback(() => {
      setMenuOpen(false);
      onManageOrg?.();
    }, [onManageOrg]);

    const renderDropdown = useCallback(
      (menu: React.ReactNode) => (
        <>
          {menu}
          <div className="border-0 border-t border-solid border-border-2 p-1">
            {onManageOrg ? (
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full border-none bg-transparent text-text-1`}
                onClick={handleManageOrg}
                data-testid="sidebar-org-manage"
              >
                <Settings2 size={13} strokeWidth={2} className="shrink-0" />
                <span className="min-w-0 truncate">{manageLabel}</span>
              </button>
            ) : null}
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full border-none bg-transparent text-text-1`}
              onClick={handleAddOrg}
              data-testid="sidebar-add-org"
            >
              <Plus size={13} strokeWidth={2} className="shrink-0" />
              <span className="min-w-0 truncate">{addOrgLabel}</span>
            </button>
          </div>
        </>
      ),
      [addOrgLabel, handleAddOrg, handleManageOrg, manageLabel, onManageOrg]
    );

    return (
      <div
        className="w-full min-w-0 [&>span]:w-full"
        data-testid="sidebar-org-selector-scope"
        data-org-id={value}
      >
        <WorkstationToolbarTooltip
          label={t("collaboration.switchOrg")}
          position="top"
          disabled={menuOpen}
        >
          <div className="w-full min-w-0">
            <Select
              value={value}
              options={options}
              onChange={handleChange}
              onVisibleChange={setMenuOpen}
              dropdownRender={renderDropdown}
              variant="ghost"
              size="small"
              radius="pill"
              dropdownWidth={250}
              dropdownAlign="left"
              className="h-7 w-full"
              style={
                {
                  "--select-ghost-hover-bg": "var(--sidebar-selected-row-bg)",
                  "--select-ghost-open-bg": "var(--sidebar-selected-row-bg)",
                } as React.CSSProperties
              }
              selectorClassName="h-7 !px-2 text-[12px] font-normal [&_.select-suffix]:ml-1 [&_.select-value]:text-[12px]"
              dataTestId="sidebar-org-selector"
            />
          </div>
        </WorkstationToolbarTooltip>
      </div>
    );
  }
);

SidebarOrgSelector.displayName = "SidebarOrgSelector";

export default SidebarOrgSelector;
