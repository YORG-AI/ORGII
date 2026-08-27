/**
 * OutputTab Configuration Hook
 *
 * Returns tab configuration for the Output panel.
 */
import { useMemo } from "react";

import { ICON_CONFIG } from "../config";
import OutputContent from "../content/OutputContent";
import type { OutputChannel } from "../content/OutputContent/types";
import type { TabAction, TabConfig } from "../types";

export interface OutputTabOptions {
  channels: OutputChannel[];
  activeChannelId: string | null;
  actions: TabAction[];
}

export function useOutputTabConfig({
  channels,
  activeChannelId,
  actions,
}: OutputTabOptions): TabConfig {
  const content = useMemo(
    () => (
      <OutputContent
        channels={channels}
        activeChannelId={activeChannelId}
        className="h-full w-full"
      />
    ),
    [channels, activeChannelId]
  );

  return {
    key: "output",
    icon: ICON_CONFIG.output,
    title: "Output",
    content,
    actions,
  };
}
