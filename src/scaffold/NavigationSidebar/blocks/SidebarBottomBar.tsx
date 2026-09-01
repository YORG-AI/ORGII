/**
 * SidebarBottomBar
 *
 * Footer strip rendered inside any sidebar variant via the `bottomContent`
 * slot. The left side accepts contextual sidebar content, such as the active
 * organization selector. User presence remains available as a reusable menu
 * for the Settings dropdown and roomier composer/header surfaces.
 *
 * Right side hosts compact contextual actions and the update control.
 */
import { useAtom, useAtomValue } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Dropdown, { type DropdownPosition } from "@src/components/Dropdown";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import PillGroup, { type PillGroupSegment } from "@src/components/PillGroup";
import {
  CircleIcon,
  HatGlassesIcon,
  HugeiconsIcon,
  type IconSvgElement,
  MoonIcon,
} from "@src/icons";
import {
  userPresenceAtom,
  userPresenceModeAtom,
} from "@src/store/user/userPresenceAtom";
import { userCustomRolesAtom } from "@src/store/user/userRolesAtom";
import {
  AWAY_DURATIONS,
  type BuiltInPresenceMode,
  USER_PRESENCE_MODE,
  type UserPresenceMode,
  buildCustomRoleMode,
  computeBackAtMs,
  isBuiltInPresenceMode,
  parseCustomRoleId,
} from "@src/types/userPresence";

import SidebarUpdateButton from "./SidebarUpdateButton";
import { resolveCustomRoleIcon } from "./customRoleIcons";

interface SidebarBottomBarProps {
  /** Content rendered in the footer's left-side slot. */
  leftContent?: React.ReactNode;
  /** Extra action buttons rendered to the left of the update control. */
  rightActions?: React.ReactNode;
}

const PRESENCE_ICON: Record<BuiltInPresenceMode, IconSvgElement> = {
  [USER_PRESENCE_MODE.ONLINE]: CircleIcon,
  [USER_PRESENCE_MODE.INVISIBLE]: HatGlassesIcon,
  [USER_PRESENCE_MODE.AWAY]: MoonIcon,
};

const PRESENCE_COLOR: Record<BuiltInPresenceMode, string> = {
  [USER_PRESENCE_MODE.ONLINE]: "text-success-6",
  [USER_PRESENCE_MODE.INVISIBLE]: "text-text-3",
  [USER_PRESENCE_MODE.AWAY]: "text-warning-6",
};

// Custom roles all render in the same neutral accent so they read as
// "user-defined" without competing with the built-ins' semantic colors.
const CUSTOM_ROLE_COLOR_CLASS = "text-primary-6";
function formatBackAt(backAtMs: number): string {
  const now = Date.now();
  const diffMs = backAtMs - now;
  if (diffMs <= 0) return "";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) {
    return remMin > 0 ? `${hours}h${remMin}m` : `${hours}h`;
  }
  const date = new Date(backAtMs);
  return date.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface PresenceItemContentProps {
  icon?: React.ReactNode;
  label: React.ReactNode;
  selected?: boolean;
}

function PresenceItemContent({
  icon,
  label,
  selected,
}: PresenceItemContentProps) {
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {selected && <DropdownSelectedCheck />}
    </>
  );
}

const PRESENCE_MENU_ORDER: ReadonlyArray<BuiltInPresenceMode> = [
  USER_PRESENCE_MODE.ONLINE,
  USER_PRESENCE_MODE.INVISIBLE,
  USER_PRESENCE_MODE.AWAY,
];

/**
 * Two label variants for the trigger pill:
 * - `concise` (default): bare status word, e.g. "Online" — fits the
 *   compact sidebar bottom strip.
 * - `detailed`: first-person framing, e.g. "I am Online" — used in
 *   roomier surfaces like the SessionCreator under the composer.
 */
type PresenceMenuButtonVariant = "concise" | "detailed";

interface PresenceMenuButtonProps {
  variant?: PresenceMenuButtonVariant;
  /**
   * Where the dropdown opens relative to the trigger pill. Defaults to
   * `top-start` since the canonical mount point is the sidebar bottom
   * bar (limited room below). Callers anchored at the top of a panel can
   * pass a `bottom-*` position so the menu drops downward instead.
   */
  dropdownPosition?: DropdownPosition;
}

const PRESENCE_LABEL_KEY: Record<
  PresenceMenuButtonVariant,
  Record<BuiltInPresenceMode, string>
> = {
  concise: {
    [USER_PRESENCE_MODE.ONLINE]: "sidebar.presence.online",
    [USER_PRESENCE_MODE.INVISIBLE]: "sidebar.presence.invisible",
    [USER_PRESENCE_MODE.AWAY]: "sidebar.presence.away",
  },
  detailed: {
    [USER_PRESENCE_MODE.ONLINE]: "sidebar.presence.iAmOnline",
    [USER_PRESENCE_MODE.INVISIBLE]: "sidebar.presence.iAmInvisible",
    [USER_PRESENCE_MODE.AWAY]: "sidebar.presence.iAmAway",
  },
};

interface PresenceMenuItemsProps {
  onSelectionComplete?: () => void;
  className?: string;
}

export const PresenceMenuItems: React.FC<PresenceMenuItemsProps> = ({
  onSelectionComplete,
  className,
}) => {
  const { t } = useTranslation("navigation");
  const [presence, setPresence] = useAtom(userPresenceAtom);
  const mode = useAtomValue(userPresenceModeAtom);
  const customRoles = useAtomValue(userCustomRolesAtom);

  const handleSelectMode = useCallback(
    (next: UserPresenceMode) => {
      if (next === USER_PRESENCE_MODE.AWAY) {
        const fallback = AWAY_DURATIONS[1];
        setPresence({
          mode: next,
          backAtMs: computeBackAtMs(fallback.id),
          awayDurationLabel: fallback.id,
        });
      } else {
        setPresence({
          mode: next,
          backAtMs: undefined,
          awayDurationLabel: undefined,
        });
      }
      onSelectionComplete?.();
    },
    [onSelectionComplete, setPresence]
  );

  const handleSelectAwayDuration = useCallback(
    (durationId: string) => {
      setPresence({
        mode: USER_PRESENCE_MODE.AWAY,
        backAtMs: computeBackAtMs(durationId),
        awayDurationLabel: durationId,
      });
      onSelectionComplete?.();
    },
    [onSelectionComplete, setPresence]
  );

  return (
    <div className={className}>
      {PRESENCE_MENU_ORDER.map((option) => {
        const OptionIcon = PRESENCE_ICON[option];
        return (
          <button
            key={option}
            type="button"
            onClick={() => handleSelectMode(option)}
            className={DROPDOWN_CLASSES.menuActionItem}
          >
            <PresenceItemContent
              icon={
                <AnyIcon
                  icon={OptionIcon}
                  size={DROPDOWN_ITEM.iconSize}
                  className={PRESENCE_COLOR[option]}
                />
              }
              label={t(`sidebar.presence.${option}`)}
              selected={option === mode}
            />
          </button>
        );
      })}

      {customRoles.length > 0 && (
        <>
          <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
          {customRoles.map((role) => {
            const RoleIcon = resolveCustomRoleIcon(role.iconId);
            const roleMode = buildCustomRoleMode(role.id);
            return (
              <button
                key={role.id}
                type="button"
                onClick={() => handleSelectMode(roleMode)}
                className={DROPDOWN_CLASSES.menuActionItem}
              >
                <PresenceItemContent
                  icon={
                    <AnyIcon
                      icon={RoleIcon}
                      size={DROPDOWN_ITEM.iconSize}
                      className={CUSTOM_ROLE_COLOR_CLASS}
                    />
                  }
                  label={role.label}
                  selected={roleMode === mode}
                />
              </button>
            );
          })}
        </>
      )}

      {mode === USER_PRESENCE_MODE.AWAY && (
        <>
          <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
          <div className={DROPDOWN_CLASSES.sectionLabel}>
            {t("sidebar.presence.awayDurationHeading")}
          </div>
          {AWAY_DURATIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => handleSelectAwayDuration(entry.id)}
              className={DROPDOWN_CLASSES.menuActionItem}
            >
              <PresenceItemContent
                label={t(entry.labelKey)}
                selected={presence.awayDurationLabel === entry.id}
              />
            </button>
          ))}
        </>
      )}
    </div>
  );
};

export const PresenceMenuButton: React.FC<PresenceMenuButtonProps> = ({
  variant = "concise",
  dropdownPosition = "top-start",
}) => {
  const { t } = useTranslation("navigation");
  const presence = useAtomValue(userPresenceAtom);
  const mode = useAtomValue(userPresenceModeAtom);
  const customRoles = useAtomValue(userCustomRolesAtom);
  const [menuVisible, setMenuVisible] = useState(false);

  const closeMenu = useCallback(() => setMenuVisible(false), []);

  const activeCustomRole = useMemo(() => {
    const id = parseCustomRoleId(mode);
    if (!id) return undefined;
    return customRoles.find((role) => role.id === id);
  }, [mode, customRoles]);

  // Resolve icon / color / label for either a built-in mode or a custom
  // role. Custom roles that have been deleted (stale `role:<id>` in the
  // presence atom) fall back to the Online appearance with a generic
  // "Unknown role" label, and the user can pick something else from the
  // menu to recover.
  const Icon = isBuiltInPresenceMode(mode)
    ? PRESENCE_ICON[mode]
    : activeCustomRole
      ? resolveCustomRoleIcon(activeCustomRole.iconId)
      : CircleIcon;
  const colorClass = isBuiltInPresenceMode(mode)
    ? PRESENCE_COLOR[mode]
    : CUSTOM_ROLE_COLOR_CLASS;
  const modeLabel = isBuiltInPresenceMode(mode)
    ? t(PRESENCE_LABEL_KEY[variant][mode])
    : (activeCustomRole?.label ??
      t("sidebar.presence.unknownRole", { defaultValue: "Unknown role" }));
  const ariaLabel = isBuiltInPresenceMode(mode)
    ? t(PRESENCE_LABEL_KEY.concise[mode])
    : (activeCustomRole?.label ??
      t("sidebar.presence.unknownRole", { defaultValue: "Unknown role" }));

  const backLabel = useMemo(() => {
    if (mode !== USER_PRESENCE_MODE.AWAY || !presence.backAtMs) return null;
    return formatBackAt(presence.backAtMs) || null;
  }, [mode, presence.backAtMs]);
  const pillLabel = backLabel ? `${modeLabel} · ${backLabel}` : modeLabel;

  // Single-segment PillGroup so the trigger matches the visual size and
  // hover/active treatment of the SessionCreator's repo / branch / model
  // pills: icon at rest, chevron on hover, chevron-up while open. The
  // surrounding Dropdown owns the click — segment onClick is a noop so
  // the parent's click handler fires unopposed.
  const segments: PillGroupSegment[] = useMemo(
    () => [
      {
        id: "presence",
        icon: <HugeiconsIcon icon={Icon} size={12} className={colorClass} />,
        label: pillLabel,
        active: menuVisible,
        ariaLabel,
        title: t("sidebar.presence.tooltip"),
      },
    ],
    [Icon, colorClass, pillLabel, menuVisible, ariaLabel, t]
  );

  const droplist = (
    <PresenceMenuItems
      className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
      onSelectionComplete={closeMenu}
    />
  );

  return (
    <Dropdown
      droplist={droplist}
      trigger="click"
      position={dropdownPosition}
      popupVisible={menuVisible}
      onVisibleChange={setMenuVisible}
    >
      <div className="inline-flex">
        <PillGroup segments={segments} />
      </div>
    </Dropdown>
  );
};

const SidebarBottomBar: React.FC<SidebarBottomBarProps> = React.memo(
  ({ leftContent, rightActions }) => {
    return (
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {leftContent}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-1">{rightActions}</div>
          <SidebarUpdateButton />
        </div>
      </div>
    );
  }
);

SidebarBottomBar.displayName = "SidebarBottomBar";

export default SidebarBottomBar;
