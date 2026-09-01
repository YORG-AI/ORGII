import { invoke as invokeTauri } from "@tauri-apps/api/core";

export const CONTAINER_STATE = {
  CREATED: "created",
  RUNNING: "running",
  PAUSED: "paused",
  RESTARTING: "restarting",
  EXITED: "exited",
  REMOVING: "removing",
  DEAD: "dead",
  STOPPING: "stopping",
  UNKNOWN: "unknown",
} as const;

type ContainerState = (typeof CONTAINER_STATE)[keyof typeof CONTAINER_STATE];

export const CONTAINER_ENGINE_KIND = {
  LOCAL: "local",
  SSH: "ssh",
  WSL: "wsl",
} as const;

type ContainerEngineKind =
  (typeof CONTAINER_ENGINE_KIND)[keyof typeof CONTAINER_ENGINE_KIND];

export interface ContainerEngineCandidate {
  id: string;
  kind: ContainerEngineKind;
  label: string;
  current: boolean;
  available: boolean;
  endpoint?: string | null;
  detail?: string | null;
}

export interface ContainerEngineStatus {
  available: boolean;
  engine_id: string;
  server_version?: string | null;
  api_version?: string | null;
  operating_system?: string | null;
  architecture?: string | null;
  error?: string | null;
}

interface ContainerPort {
  private_port: number;
  public_port?: number | null;
  protocol?: string | null;
  ip?: string | null;
}

interface ContainerMount {
  source?: string | null;
  destination?: string | null;
  mode?: string | null;
  writable?: boolean | null;
  mount_type?: string | null;
}

interface ContainerComposeInfo {
  project?: string | null;
  service?: string | null;
  working_dir?: string | null;
}

export interface ContainerSummary {
  id: string;
  short_id: string;
  names: string[];
  display_name: string;
  image?: string | null;
  image_id?: string | null;
  command?: string | null;
  created_at?: number | null;
  state: ContainerState;
  status?: string | null;
  ports: ContainerPort[];
  mounts: ContainerMount[];
  labels: Record<string, string>;
  compose: ContainerComposeInfo;
}

export interface ContainerInspect {
  summary: ContainerSummary;
  started_at?: string | null;
  finished_at?: string | null;
  restart_count?: number | null;
  working_dir?: string | null;
  entrypoint?: string[] | null;
  environment: string[];
  raw: unknown;
}

export const containerApi = {
  pingEngine(): Promise<ContainerEngineStatus> {
    return invokeTauri<ContainerEngineStatus>("container_engine_ping");
  },

  listEngineCandidates(): Promise<ContainerEngineCandidate[]> {
    return invokeTauri<ContainerEngineCandidate[]>(
      "container_engine_candidates"
    );
  },

  listContainers(): Promise<ContainerSummary[]> {
    return invokeTauri<ContainerSummary[]>("container_list");
  },

  inspectContainer(containerId: string): Promise<ContainerInspect> {
    return invokeTauri<ContainerInspect>("container_inspect", { containerId });
  },

  startContainer(containerId: string): Promise<void> {
    return invokeTauri<void>("container_start", { containerId });
  },

  stopContainer(containerId: string): Promise<void> {
    return invokeTauri<void>("container_stop", { containerId });
  },

  restartContainer(containerId: string): Promise<void> {
    return invokeTauri<void>("container_restart", { containerId });
  },
};
