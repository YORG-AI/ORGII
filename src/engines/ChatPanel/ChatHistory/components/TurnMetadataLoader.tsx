import { useStore } from "jotai";
import React, { memo, useEffect, useRef } from "react";

import { loadTurnIndex } from "@src/engines/SessionCore/storage/cacheAdapter";

import { turnMetadataAtomFamily, turnMetadataKey } from "../turnMetadataAtom";

interface TurnMetadataLoaderProps {
  sessionId: string | null;
  reloadKey: string;
  turnIds: readonly (string | null)[];
}

/**
 * Loads materialized round metadata without putting the result in
 * ChatHistory state. Only footer slots subscribed to the affected turn atoms
 * update when the DB response arrives.
 */
const TurnMetadataLoader: React.FC<TurnMetadataLoaderProps> = memo(
  ({ sessionId, reloadKey, turnIds }) => {
    const store = useStore();
    const retainedKeysRef = useRef(new Set<string>());
    // Projection arrays are recreated during history refreshes. Depend on
    // their values, not identity, so unchanged refreshes cannot trigger a
    // duplicate metadata RPC.
    const turnIdsKey = JSON.stringify(
      turnIds.filter((turnId): turnId is string => Boolean(turnId))
    );

    useEffect(() => {
      const retainedKeys = retainedKeysRef.current;
      return () => {
        for (const key of retainedKeys) {
          store.set(turnMetadataAtomFamily(key), undefined);
          turnMetadataAtomFamily.remove(key);
        }
        retainedKeys.clear();
      };
    }, [sessionId, store]);

    useEffect(() => {
      if (!sessionId) return;
      let cancelled = false;
      const visibleTurnIds = JSON.parse(turnIdsKey) as string[];
      const visibleKeys = new Set(
        visibleTurnIds.map((turnId) => turnMetadataKey(sessionId, turnId))
      );
      for (const key of retainedKeysRef.current) {
        if (visibleKeys.has(key)) continue;
        store.set(turnMetadataAtomFamily(key), undefined);
        turnMetadataAtomFamily.remove(key);
        retainedKeysRef.current.delete(key);
      }
      for (const key of visibleKeys) retainedKeysRef.current.add(key);

      if (visibleTurnIds.length === 0) return;
      void loadTurnIndex(sessionId, visibleTurnIds)
        .then((turns) => {
          if (cancelled) return;
          const summaries = new Map(turns.map((turn) => [turn.turnId, turn]));
          for (const turnId of visibleTurnIds) {
            store.set(
              turnMetadataAtomFamily(turnMetadataKey(sessionId, turnId)),
              summaries.get(turnId) ?? null
            );
          }
        })
        .catch(() => {
          if (cancelled) return;
          // Keep `undefined` on load failure: the footer must not claim that
          // a round had no changes when metadata was simply unavailable.
          for (const turnId of visibleTurnIds) {
            store.set(
              turnMetadataAtomFamily(turnMetadataKey(sessionId, turnId)),
              undefined
            );
          }
        });

      return () => {
        cancelled = true;
      };
    }, [reloadKey, sessionId, store, turnIdsKey]);

    return null;
  }
);

TurnMetadataLoader.displayName = "TurnMetadataLoader";

export default TurnMetadataLoader;
