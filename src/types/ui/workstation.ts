/** Dependency-free identifiers shared by workstation state and API snapshots. */
export const STATION_MODES = ["my-station", "agent-station"] as const;

export type StationMode = (typeof STATION_MODES)[number];

export const STATION_MODE = {
  MY_STATION: "my-station",
  AGENT_STATION: "agent-station",
} as const satisfies Record<string, StationMode>;

export type StatusBarAppType = "code" | "data" | "browser" | "project";
