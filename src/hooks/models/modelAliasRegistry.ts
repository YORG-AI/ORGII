/**
 * Runtime registry mapping model ids to user-chosen model alias metadata.
 *
 * Populated from key records on app startup and refreshed after key-vault
 * mutations. Consumed by model icons and model label renderers as the
 * highest-priority lookup before model-id inference/formatting.
 */
import { useSyncExternalStore } from "react";

import type { IconProvider } from "@src/components/ModelIcon/config";

interface KeyRecordWithModelAliases {
  id?: string;
  model_aliases?: Array<{
    alias?: string | null;
    display_name?: string | null;
    displayName?: string | null;
    icon?: string | null;
  }>;
}

const modelAliasIconMap = new Map<string, IconProvider>();
const modelAliasDisplayNameMap = new Map<string, string>();
const keyDisplayNames = new Map<string, Map<string, string>>();
const subscribers = new Set<() => void>();
let version = 0;

function notifySubscribers(): void {
  version += 1;
  subscribers.forEach((subscriber) => subscriber());
}

function subscribeModelAliases(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function getModelAliasSnapshot(): number {
  return version;
}

export function useModelAliasRegistryVersion(): number {
  return useSyncExternalStore(
    subscribeModelAliases,
    getModelAliasSnapshot,
    getModelAliasSnapshot
  );
}

export function getModelAliasIcon(modelName: string): IconProvider | undefined {
  return modelAliasIconMap.get(modelName);
}

export function getModelAliasDisplayName(
  modelName: string,
  keyId?: string
): string | undefined {
  return keyId
    ? keyDisplayNames.get(keyId)?.get(modelName)
    : modelAliasDisplayNameMap.get(modelName);
}

export function replaceModelAliasesFromKeys(
  keys: KeyRecordWithModelAliases[]
): void {
  modelAliasIconMap.clear();
  modelAliasDisplayNameMap.clear();
  keyDisplayNames.clear();
  const ambiguous = new Set<string>();
  for (const key of keys) {
    const labels = new Map<string, string>();
    if (key.id) keyDisplayNames.set(key.id, labels);
    for (const alias of key.model_aliases ?? []) {
      if (!alias.alias) continue;
      if (alias.icon) {
        modelAliasIconMap.set(alias.alias, alias.icon as IconProvider);
      }
      const displayName = alias.display_name ?? alias.displayName;
      if (displayName?.trim()) {
        labels.set(alias.alias, displayName);
        const previous = modelAliasDisplayNameMap.get(alias.alias);
        if (previous !== undefined && previous !== displayName)
          ambiguous.add(alias.alias);
        modelAliasDisplayNameMap.set(alias.alias, displayName);
      }
    }
  }
  for (const model of ambiguous) modelAliasDisplayNameMap.delete(model);
  notifySubscribers();
}
