import React from "react";
import { useTranslation } from "react-i18next";

import PersonAvatar from "@src/components/PersonAvatar";
import { HugeiconsIcon, Login01Icon } from "@src/icons";

interface SidebarAccountButtonProps {
  /** Resolved cloud identity; `null` means the user is signed out. */
  identity: string | null;
  avatarUrl?: string;
  menuOpen: boolean;
  onClick: () => void;
}

const SidebarAccountButton: React.FC<SidebarAccountButtonProps> = React.memo(
  ({ identity, avatarUrl, menuOpen, onClick }) => {
    const { t } = useTranslation("navigation");
    const signedIn = identity !== null;
    const label = signedIn ? identity : t("cloud.signIn");

    return (
      <button
        type="button"
        className={`flex h-8 min-w-0 flex-1 items-center rounded-lg border-none px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/40 ${
          menuOpen
            ? "bg-sidebar-selected"
            : "bg-transparent hover:bg-sidebar-selected"
        }`}
        onClick={onClick}
        aria-label={
          signedIn ? t("cloud.signedInAs", { name: identity }) : label
        }
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={label}
        data-testid={
          signedIn ? "sidebar-account-profile" : "sidebar-account-sign-in"
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          {signedIn ? (
            <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center overflow-visible">
              <PersonAvatar size={20} src={avatarUrl} name={identity} />
            </span>
          ) : (
            <HugeiconsIcon
              icon={Login01Icon}
              data-icon="log-in"
              size={14}
              strokeWidth={2}
              className="shrink-0 text-text-1"
              aria-hidden
            />
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] leading-4 text-text-1">
            {label}
          </span>
        </span>
      </button>
    );
  }
);

SidebarAccountButton.displayName = "SidebarAccountButton";

export default SidebarAccountButton;
