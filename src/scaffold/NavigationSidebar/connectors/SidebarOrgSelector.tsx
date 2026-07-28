import { CircleCheck, LogIn, Plus, Settings2 } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import Select, { type SelectOption } from "@src/components/Select";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";

interface SidebarOrgSelectorProps {
  value: string;
  options: SelectOption[];
  addOrgLabel: string;
  /** ORG2 Cloud identity shown in the menu; `null` means signed out. */
  cloudSignedInIdentity: string | null;
  /** Label for the always-visible manage-org entry. */
  manageLabel: string;
  onChange: (orgId: string) => void;
  onAddOrg: () => void;
  onCloudSignIn: () => void;
  /**
   * Explicit management entry for the ACTIVE org (cloud orgs only —
   * selector picks switch scope, management needs its own entry).
   */
  onManageOrg: () => void;
}

const SidebarOrgSelector: React.FC<SidebarOrgSelectorProps> = React.memo(
  ({
    value,
    options,
    addOrgLabel,
    cloudSignedInIdentity,
    manageLabel,
    onChange,
    onAddOrg,
    onCloudSignIn,
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

    const handleCloudSignIn = useCallback(() => {
      setMenuOpen(false);
      onCloudSignIn();
    }, [onCloudSignIn]);

    const handleManageOrg = useCallback(() => {
      setMenuOpen(false);
      onManageOrg?.();
    }, [onManageOrg]);

    const renderDropdown = useCallback(
      (menu: React.ReactNode) => (
        <>
          {menu}
          <div
            className={`${DROPDOWN_CLASSES.itemsColumn} shrink-0 border-0 border-t border-solid border-border-2 p-1`}
          >
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full border-none bg-transparent text-text-1`}
              onClick={handleManageOrg}
              data-testid="sidebar-org-manage"
            >
              <Settings2 size={13} strokeWidth={2} className="shrink-0" />
              <span className="min-w-0 truncate">{manageLabel}</span>
            </button>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full border-none bg-transparent text-text-1`}
              onClick={handleAddOrg}
              data-testid="sidebar-add-org"
            >
              <Plus size={13} strokeWidth={2} className="shrink-0" />
              <span className="min-w-0 truncate">{addOrgLabel}</span>
            </button>
            {cloudSignedInIdentity !== null ? (
              <div
                className={`${DROPDOWN_CLASSES.item} !cursor-default !text-text-2`}
                data-testid="sidebar-cloud-signed-in"
              >
                <CircleCheck
                  size={13}
                  strokeWidth={2}
                  className="shrink-0 text-success-6"
                />
                <span
                  className="min-w-0 truncate"
                  title={t("cloud.signedInAs", {
                    name: cloudSignedInIdentity,
                  })}
                >
                  {t("cloud.signedInAs", { name: cloudSignedInIdentity })}
                </span>
              </div>
            ) : (
              <button
                type="button"
                className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full border-none bg-transparent text-text-1`}
                onClick={handleCloudSignIn}
                data-testid="sidebar-cloud-sign-in"
              >
                <LogIn size={13} strokeWidth={2} className="shrink-0" />
                <span className="min-w-0 truncate">{t("cloud.signIn")}</span>
              </button>
            )}
          </div>
        </>
      ),
      [
        addOrgLabel,
        cloudSignedInIdentity,
        handleAddOrg,
        handleCloudSignIn,
        handleManageOrg,
        manageLabel,
        t,
      ]
    );

    return (
      <div
        className="w-full min-w-0 [&>span]:w-full"
        data-testid="sidebar-org-selector-scope"
        data-org-id={value}
      >
        <WorkstationToolbarTooltip
          label={t("collaboration.switchOrg")}
          position="bottom"
          disabled={menuOpen}
        >
          <div className="w-full min-w-0">
            <Select
              value={value}
              options={options}
              onChange={handleChange}
              onVisibleChange={setMenuOpen}
              popupVisible={menuOpen}
              dropdownRender={renderDropdown}
              showTriggerIcon={false}
              variant="ghost"
              size="small"
              radius="lg"
              dropdownWidth={250}
              dropdownAlign="left"
              className="h-8 w-full"
              selectorClassName={`h-8 !px-2 [&_.select-arrow]:!text-text-2 [&_.select-suffix]:ml-2 [&_.select-value]:!flex-initial [&_.select-value]:gap-3 [&_.select-value]:text-[13px] [&_.select-value]:font-semibold ${
                menuOpen ? "!bg-sidebar-selected" : "hover:!bg-sidebar-selected"
              }`}
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
