/**
 * Channel transcript header — `#name`, topic, and (cloud only) member count,
 * laid out with the shared 40px published-header slots.
 *
 * The settings affordance opens the EXISTING dialogs (`ChannelSettingsDialog`
 * for cloud, `LocalChannelSettingsDialog` for local); this header only raises
 * the request — the owning view mounts whichever dialog matches the scope.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import { PublishedHeaderSlotsView } from "@src/components/WindowChrome";
import {
  HashtagIcon,
  HugeiconsIcon,
  LockIcon,
  Settings02Icon,
  UserMultipleIcon,
} from "@src/icons";
import { PANEL_HEADER_TOKENS } from "@src/modules/shared/layouts/blocks";

export interface ChannelPanelHeaderProps {
  name: string;
  topic: string | undefined;
  /** Cloud private channels get the lock the sidebar row already uses. */
  isPrivate: boolean;
  /** Undefined for local channels — a single-user channel has no roster. */
  memberCount: number | undefined;
  onOpenSettings: () => void;
}

const ChannelPanelHeader: React.FC<ChannelPanelHeaderProps> = ({
  name,
  topic,
  isPrivate,
  memberCount,
  onOpenSettings,
}) => {
  const { t } = useTranslation("navigation");
  const NameIcon = isPrivate ? LockIcon : HashtagIcon;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border-2 pr-2"
      data-testid="channel-panel-header"
    >
      <PublishedHeaderSlotsView
        slots={{
          content: (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="flex h-6 min-w-0 items-center px-1 text-[13px] leading-6">
                <span
                  className="mr-1.5 inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-2"
                  aria-hidden
                >
                  <AnyIcon
                    icon={NameIcon}
                    size={PANEL_HEADER_TOKENS.iconSize}
                    strokeWidth={2}
                    className="shrink-0"
                  />
                </span>
                <span
                  className="truncate font-medium text-text-1"
                  data-testid="channel-panel-title"
                >
                  {name}
                </span>
              </span>
              {topic ? (
                <>
                  <span className="h-3 w-px shrink-0 bg-border-2" aria-hidden />
                  <span
                    className="truncate text-[12px] text-text-3"
                    data-testid="channel-panel-topic"
                  >
                    {topic}
                  </span>
                </>
              ) : null}
            </div>
          ),
          trailing: (
            <>
              {memberCount === undefined ? null : (
                <span
                  className="inline-flex items-center gap-1 text-[11px] text-text-3"
                  data-testid="channel-panel-member-count"
                >
                  <HugeiconsIcon
                    icon={UserMultipleIcon}
                    data-icon="users"
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  {memberCount}
                </span>
              )}
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                icon={
                  <HugeiconsIcon
                    icon={Settings02Icon}
                    data-icon="settings-2"
                    size={PANEL_HEADER_TOKENS.iconSize}
                    strokeWidth={2}
                  />
                }
                title={t("cloud.channels.settings.action")}
                aria-label={t("cloud.channels.settings.action")}
                data-testid="channel-panel-settings"
                onClick={onOpenSettings}
              />
            </>
          ),
        }}
      />
    </div>
  );
};

export default ChannelPanelHeader;
