import { Globe } from "lucide-react";
import React from "react";

import { createLogger } from "@src/hooks/logger";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { HoverCardRow } from "./HoverCardBase";

const logger = createLogger("HoverCardUrlRow");

export const HOVER_CARD_LINK_ROW_CLASS_NAME =
  "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-2 underline-offset-2 transition-colors hover:text-accent-9 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-8";

const COMPACT_URL_MAX_CHARS = 44;

function formatCompactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const compact = `${parsed.host}${parsed.pathname}${parsed.search}`.replace(
      /\/$/,
      ""
    );
    if (compact.length <= COMPACT_URL_MAX_CHARS) return compact;
    return `${compact.slice(0, COMPACT_URL_MAX_CHARS - 1).trimEnd()}…`;
  } catch {
    if (url.length <= COMPACT_URL_MAX_CHARS) return url;
    return `${url.slice(0, COMPACT_URL_MAX_CHARS - 1).trimEnd()}…`;
  }
}

function handleOpenUrl(url: string): void {
  void openExternalLink(url).catch((error: unknown) => {
    logger.warn("failed to open hover card url", { error, url });
  });
}

interface HoverCardUrlRowProps {
  url: string;
}

export const HoverCardUrlRow: React.FC<HoverCardUrlRowProps> = ({ url }) => {
  const label = formatCompactUrl(url);

  return (
    <HoverCardRow icon={<Globe size={13} strokeWidth={1.75} />}>
      <button
        type="button"
        className={HOVER_CARD_LINK_ROW_CLASS_NAME}
        title={url}
        onClick={() => handleOpenUrl(url)}
      >
        {label}
      </button>
    </HoverCardRow>
  );
};

HoverCardUrlRow.displayName = "HoverCardUrlRow";
