import type { WorkStationTabType } from "@src/store/workstation/tabs";

export function shouldShowWorkStationStatusBar({
  statusBarHidden,
  isAgentStation,
  activeTabType,
}: {
  statusBarHidden: boolean;
  isAgentStation: boolean;
  activeTabType?: WorkStationTabType;
}): boolean {
  return (
    !statusBarHidden && !isAgentStation && activeTabType !== "chat-session"
  );
}
