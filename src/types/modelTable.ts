import type { ModelVariantInfo } from "@src/api/types/keys";

export type ModelTableViewMode = "flat" | "group";

/** Alias row compatible with Key Vault wizard `ModelAlias` (structural). */
export interface ModelTableModelAlias {
  displayName: string;
  alias: string;
  icon?: string;
  /** Transient unnamed row; never persisted as a model ID */
  isDraft?: boolean;
  rowId?: string;
}

export interface ModelTableVariantInfo extends ModelVariantInfo {
  model: string;
  base_model: string;
  reasoning?: string | null;
  fast: boolean;
}
