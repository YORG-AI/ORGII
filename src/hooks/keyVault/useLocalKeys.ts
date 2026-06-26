/**
 * useLocalKeys Hook
 *
 * Manages local CLI agent keys.
 *
 * Features:
 * - Load keys from local credentials store
 * - Save, delete, validate, and refresh quotas per key
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deleteKey as deleteKeyRpc,
  fetchKeyQuota,
  getFullKey,
  getKey,
  listKeys,
  saveKey as saveKeyRpc,
  updateKeyHealth,
  validateKey as validateKeyRpc,
} from "@src/api/services/keyValidation";
import type {
  KeyInfo,
  ModelType,
  SaveKeyRequest,
} from "@src/api/services/keyValidation";
import { CLI_AGENT } from "@src/api/tauri/rpc/schemas/validation";
import { createLogger } from "@src/hooks/logger";
import { replaceModelAliasesFromKeys } from "@src/hooks/models/modelAliasRegistry";

const log = createLogger("useLocalKeys");

// Re-export types for convenience
export type { ModelType, KeyInfo };

// ============================================
// Type Definitions
// ============================================

export interface UseLocalKeysOptions {
  /** Auto-load keys on mount */
  autoDetect?: boolean;
}

export interface UseLocalKeysReturn {
  /** All stored keys (array, supports multiple per agent type) */
  allKeys: KeyInfo[];
  /** Stored keys by agent type (legacy, returns first match) */
  keysByAgentType: Map<ModelType, KeyInfo>;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Reload keys from the store */
  refreshAgents: (force?: boolean) => Promise<void>;
  /** Save key manually - returns saved key or null */
  saveKey: (request: SaveKeyRequest) => Promise<KeyInfo | null>;
  /** Delete key */
  deleteKey: (agentType: ModelType, keyId?: string) => Promise<boolean>;
  /** Refresh quota for a key */
  refreshQuota: (
    agentType: ModelType,
    keyId?: string,
    force?: boolean
  ) => Promise<boolean>;
  /** Validate key and detect available models (tests models in parallel) */
  validateKey: (agentType: ModelType) => Promise<boolean>;
}

let sharedAllKeys: KeyInfo[] = [];
const sharedAllKeysListeners = new Set<(keys: KeyInfo[]) => void>();

function publishAllKeys(keys: KeyInfo[]) {
  sharedAllKeys = keys;
  for (const listener of sharedAllKeysListeners) {
    listener(keys);
  }
}

function updateSharedAllKeys(updater: (prev: KeyInfo[]) => KeyInfo[]) {
  const next = updater(sharedAllKeys);
  publishAllKeys(next);
  return next;
}

// ============================================
// Hook Implementation
// ============================================

export function useLocalKeys(
  options: UseLocalKeysOptions = {}
): UseLocalKeysReturn {
  const { autoDetect: autoDetectOnMount = true } = options;

  // State
  const [allKeys, setAllKeys] = useState<KeyInfo[]>(sharedAllKeys);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track in-flight validations to prevent duplicates
  const pendingValidations = useRef<Set<string>>(new Set());

  useEffect(() => {
    sharedAllKeysListeners.add(setAllKeys);
    return () => {
      sharedAllKeysListeners.delete(setAllKeys);
    };
  }, []);

  // Derive keys Map from allKeys (first match per agent type - legacy support)
  const keysByAgentType = useMemo(() => {
    const keyMap = new Map<ModelType, KeyInfo>();
    for (const key of allKeys) {
      if (!keyMap.has(key.agent_type)) {
        keyMap.set(key.agent_type, key);
      }
    }
    return keyMap;
  }, [allKeys]);

  // ============================================
  // Core Methods
  // ============================================

  const refreshAgents = useCallback(async (_force = false) => {
    setLoading(true);
    setError(null);

    try {
      const keys = await listKeys();
      publishAllKeys(keys);
      replaceModelAliasesFromKeys(keys);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      log.error("Failed to load keys:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Validate key and detect available models
   *
   * @param agentType - Agent type
   * @param keyId - Optional key ID (for multi-account support)
   */
  const validateKeyFn = useCallback(
    async (agentType: ModelType, keyId?: string): Promise<boolean> => {
      try {
        const fullKey = await getFullKey(agentType, keyId);
        if (!fullKey?.api_key) return false;

        const testModel =
          fullKey.model_aliases && fullKey.model_aliases.length > 0
            ? fullKey.model_aliases[0].alias
            : undefined;

        const result = await validateKeyRpc(
          agentType,
          fullKey.api_key,
          fullKey.base_url ?? undefined,
          fullKey.session_token ?? undefined,
          testModel,
          fullKey.protocol ?? undefined
        );

        await updateKeyHealth(
          fullKey.id,
          result.valid ? "valid" : "invalid",
          result.valid ? undefined : result.message,
          result.models_available
        );

        const updated = await getKey(agentType, keyId);
        if (updated) {
          updateSharedAllKeys((prev) => {
            const idx = prev.findIndex((k) => k.id === updated.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated;
              return next;
            }
            return [...prev, updated];
          });
          return result.valid;
        }
        return false;
      } catch {
        return false;
      }
    },
    []
  );

  /**
   * Save key manually
   */
  const saveKeyFn = useCallback(
    async (request: SaveKeyRequest): Promise<KeyInfo | null> => {
      const previousKeys = sharedAllKeys;
      let appliedOptimisticUpdate = false;

      if (request.id) {
        updateSharedAllKeys((prev) => {
          const idx = prev.findIndex((key) => key.id === request.id);
          if (idx < 0) return prev;

          const next = [...prev];
          next[idx] = {
            ...next[idx],
            name: request.name ?? next[idx].name,
            description: request.description ?? next[idx].description,
            base_url: request.base_url ?? next[idx].base_url,
            protocol: request.protocol ?? next[idx].protocol,
            available_models:
              request.available_models ?? next[idx].available_models,
            enabled_models: request.enabled_models ?? next[idx].enabled_models,
            model_aliases: request.model_aliases ?? next[idx].model_aliases,
            model_variants: request.model_variants ?? next[idx].model_variants,
            default_variants:
              request.default_variants ?? next[idx].default_variants,
            quota_info: request.quota_info ?? next[idx].quota_info,
            has_local_key: request.has_local_key ?? next[idx].has_local_key,
            is_listed: request.is_listed ?? next[idx].is_listed,
            auth_method: request.auth_method ?? next[idx].auth_method,
            listing_id: request.listing_id ?? next[idx].listing_id,
            enabled: request.enabled ?? next[idx].enabled,
          };
          appliedOptimisticUpdate = true;
          replaceModelAliasesFromKeys(next);
          return next;
        });
      }

      try {
        const saved = await saveKeyRpc(request);
        updateSharedAllKeys((prev) => {
          const idx = prev.findIndex((k) => k.id === saved.id);
          const next = [...prev];
          if (idx >= 0) {
            next[idx] = saved;
          } else {
            next.push(saved);
          }
          replaceModelAliasesFromKeys(next);
          return next;
        });
        return saved;
      } catch {
        if (appliedOptimisticUpdate) {
          publishAllKeys(previousKeys);
          replaceModelAliasesFromKeys(previousKeys);
        }
        return null;
      }
    },
    []
  );

  /**
   * Delete key
   *
   * @param agentType - Agent type
   * @param keyId - Optional key ID (for multi-account support)
   */
  const deleteKeyFn = useCallback(
    async (agentType: ModelType, keyId?: string): Promise<boolean> => {
      try {
        const deleted = await deleteKeyRpc(agentType, keyId);
        if (deleted) {
          updateSharedAllKeys((prev) => {
            const next = keyId
              ? prev.filter((k) => k.id !== keyId)
              : prev.filter((k) => k.agent_type !== agentType);
            replaceModelAliasesFromKeys(next);
            return next;
          });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    []
  );

  /**
   * Refresh key (unified endpoint)
   *
   * Uses caching:
   * - If recently validated (< 5 min), returns cached result
   * - Use force=true to bypass cache and validate immediately
   * - Prevents duplicate concurrent validations for same key
   *
   * @param agentType - Agent type
   * @param keyId - Optional key ID (for multi-account support)
   * @param force - Force validation even if recently validated
   */
  const refreshQuotaFn = useCallback(
    async (
      agentType: ModelType,
      keyId?: string,
      _force?: boolean
    ): Promise<boolean> => {
      const validationKey = `${agentType}:${keyId || "default"}`;

      if (pendingValidations.current.has(validationKey)) {
        return false;
      }

      pendingValidations.current.add(validationKey);

      try {
        const fullKey = await getFullKey(agentType, keyId);
        if (!fullKey) return false;

        let tokenForQuota: string | undefined;
        if (agentType === CLI_AGENT.CURSOR) {
          tokenForQuota = fullKey.session_token ?? undefined;
        } else if (agentType === CLI_AGENT.COPILOT) {
          tokenForQuota = fullKey.api_key ?? undefined;
        }

        if (tokenForQuota) {
          const quota = await fetchKeyQuota(agentType, tokenForQuota);
          await updateKeyHealth(
            fullKey.id,
            "valid",
            undefined,
            undefined,
            undefined,
            quota
          );
        } else if (fullKey.api_key) {
          const testModel =
            fullKey.model_aliases && fullKey.model_aliases.length > 0
              ? fullKey.model_aliases[0].alias
              : undefined;

          const result = await validateKeyRpc(
            agentType,
            fullKey.api_key,
            fullKey.base_url ?? undefined,
            undefined,
            testModel,
            fullKey.protocol ?? undefined
          );

          const modelsToSave =
            result.models_available && result.models_available.length > 0
              ? result.models_available
              : undefined;

          await updateKeyHealth(
            fullKey.id,
            result.valid ? "valid" : "invalid",
            result.valid ? undefined : result.message,
            modelsToSave
          );
        } else {
          return false;
        }

        const updated = await getKey(agentType, keyId);
        if (updated) {
          updateSharedAllKeys((prev) => {
            const idx = prev.findIndex((k) => k.id === updated.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated;
              return next;
            }
            return prev;
          });
        }

        return true;
      } catch (err) {
        log.error(`[Refresh] Error:`, err);
        return false;
      } finally {
        pendingValidations.current.delete(validationKey);
      }
    },
    []
  );

  // ============================================
  // Effects
  // ============================================

  useEffect(() => {
    if (autoDetectOnMount) {
      refreshAgents();
    }
  }, [autoDetectOnMount, refreshAgents]);

  // ============================================
  // Return
  // ============================================

  return {
    allKeys,
    keysByAgentType,
    loading,
    error,
    refreshAgents,
    saveKey: saveKeyFn,
    deleteKey: deleteKeyFn,
    refreshQuota: refreshQuotaFn,
    validateKey: validateKeyFn,
  };
}

export default useLocalKeys;
