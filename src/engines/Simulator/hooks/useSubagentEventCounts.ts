/** Activity flags for ranking children before pagination. Values are 0/1,
 * not transcript lengths: no off-page history is hydrated for sorting. */
import { useEffect, useRef, useState } from "react";

import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";

import type { SubagentSession } from "./useSubagentSessions";

type CountMap = ReadonlyMap<string, number>;
const EMPTY_MAP: CountMap = new Map();

export function useSubagentEventCounts(
  subagentSessions: SubagentSession[]
): CountMap {
  const [counts, setCounts] = useState<CountMap>(EMPTY_MAP);
  const known = useRef(new Map<string, number>());
  const idsKey = JSON.stringify(
    [...new Set(subagentSessions.map((sub) => sub.sessionId))].sort()
  );
  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    const membership = new Set(ids);
    let disposed = false;
    let probing = false;
    let unsubscribers: Array<() => void> = [];
    known.current = new Map(
      [...known.current].filter(([id]) => membership.has(id))
    );
    const publish = () => {
      if (!disposed) setCounts(new Map(known.current));
    };
    queueMicrotask(() => {
      if (!disposed) publish();
    });
    const applyActivity = (id: string, active: boolean) => {
      if (disposed || document.hidden) return;
      // A partial streaming window cannot disprove earlier activity.
      const next = active || known.current.get(id) === 1 ? 1 : 0;
      if (known.current.get(id) === next) return;
      known.current.set(id, next);
      publish();
    };
    const probe = async () => {
      if (disposed || document.hidden || probing) return;
      probing = true;
      try {
        const missing = ids.filter((id) => !known.current.has(id));
        for (let offset = 0; offset < missing.length; offset += 64) {
          if (disposed || document.hidden) break;
          const activity = await eventStoreProxy.getChatActivity(
            missing.slice(offset, offset + 64)
          );
          if (disposed || document.hidden) break;
          for (const [id, active] of Object.entries(activity)) {
            if (membership.has(id))
              known.current.set(
                id,
                active || known.current.get(id) === 1 ? 1 : 0
              );
          }
          publish();
        }
      } catch {
        // Unknown stays unknown. Retry on the next visibility transition or roster change.
      } finally {
        probing = false;
      }
    };
    const resume = () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      unsubscribers = [];
      if (disposed || document.hidden) return;
      // Negative probes may become positive after an external import while hidden.
      for (const [id, count] of known.current)
        if (count === 0) known.current.delete(id);
      for (const id of ids) {
        unsubscribers.push(
          eventStoreProxy.subscribeSession(id, (snapshot) => {
            if (snapshot.chatEvents?.length) applyActivity(id, true);
          })
        );
        const latest = eventStoreProxy.getLatestSessionSnapshot(id);
        if (latest?.chatEvents?.length) applyActivity(id, true);
      }
      void probe();
    };
    // Defer initial state publications out of the effect body.
    queueMicrotask(resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", resume);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [idsKey]);
  if (subagentSessions.length === 0) return EMPTY_MAP;
  const membership = new Set(subagentSessions.map((sub) => sub.sessionId));
  // Identity switches must not expose an old parent's result for even one render.
  return [...counts.keys()].every((id) => membership.has(id))
    ? counts
    : new Map([...counts].filter(([id]) => membership.has(id)));
}
