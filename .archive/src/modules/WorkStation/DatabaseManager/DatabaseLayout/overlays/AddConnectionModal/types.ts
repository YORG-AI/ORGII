import type { DatabaseConnectionConfig } from "@src/engines/DatabaseCore";

export interface AddConnectionModalProps {
  isOpen: boolean;
  onAdd: (config: DatabaseConnectionConfig) => Promise<string> | void;
  onClose: () => void;
}

export type ConnectionStatus =
  | "idle"
  | "testing"
  | "success"
  | "error"
  | "adding";
