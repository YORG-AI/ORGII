import { openUrl } from "@tauri-apps/plugin-opener";
import { Chromium, Copy } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import HoverCardBase, {
  HoverCardPanel,
} from "@src/components/SessionHoverCard/HoverCardBase";
import { copyText } from "@src/util/data/clipboard";

import {
  type HttpLinkPreview,
  getHttpLinkPreview,
} from "./LinkHoverCard.helpers";
import { openUrlInBrowserApp } from "./markdownUtils";

interface LinkHoverCardProps {
  url: string;
  children: React.ReactElement;
}

const LinkHoverCardContent: React.FC<{ preview: HttpLinkPreview }> = ({
  preview,
}) => {
  const { t } = useTranslation("sessions");

  const handleCopy = useCallback(async () => {
    try {
      await copyText(preview.url);
      Message.success(t("cards.url.copied"));
    } catch {
      Message.error(t("failedToCopyContent"));
    }
  }, [preview.url, t]);

  const handleOpenInApp = useCallback(() => {
    openUrlInBrowserApp(preview.url, { navigate: true });
  }, [preview.url]);

  const handleOpenExternal = useCallback(() => {
    void openUrl(preview.url).catch(() => {
      Message.error(t("cards.url.openExternalFailed"));
    });
  }, [preview.url, t]);

  return (
    <HoverCardPanel title={preview.host}>
      <div
        className="truncate text-[12px] leading-5 text-text-3"
        title={preview.url}
      >
        {preview.displayUrl}
      </div>
      <div className="flex items-center justify-end gap-1 border-t border-border-1 pt-2">
        <Button
          variant="secondary"
          size="mini"
          icon={<Copy size={13} />}
          iconOnly
          aria-label={t("cards.url.copyUrl")}
          title={t("cards.url.copyUrl")}
          onClick={handleCopy}
        />
        <Button
          variant="secondary"
          size="mini"
          icon={<Chromium size={13} strokeWidth={1.75} />}
          iconOnly
          aria-label={t("cards.actions.openWithDefaultBrowser")}
          title={t("cards.actions.openWithDefaultBrowser")}
          onClick={handleOpenExternal}
        />
        <Button variant="primary" size="mini" onClick={handleOpenInApp}>
          {t("cards.actions.openInApp")}
        </Button>
      </div>
    </HoverCardPanel>
  );
};

const LinkHoverCard: React.FC<LinkHoverCardProps> = ({ url, children }) => {
  const preview = getHttpLinkPreview(url);
  if (!preview) return children;

  return (
    <HoverCardBase
      cardId={preview.url}
      position="bottom-start"
      mouseEnterDelay={350}
      renderContent={() => <LinkHoverCardContent preview={preview} />}
    >
      {children}
    </HoverCardBase>
  );
};

LinkHoverCard.displayName = "LinkHoverCard";

export default LinkHoverCard;
