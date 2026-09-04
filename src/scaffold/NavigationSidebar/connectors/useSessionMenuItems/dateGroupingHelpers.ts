import type { Session } from "@src/store/session";
import {
  SESSION_DATE_BUCKET_KEYS,
  type SessionDateBucket,
  getSessionDateBucket,
} from "@src/util/session/sessionDateBuckets";

export const DATE_GROUP_KEYS = SESSION_DATE_BUCKET_KEYS;

export type DateGroupKey = SessionDateBucket;

export function getDateGroup(session: Session): DateGroupKey {
  return getSessionDateBucket(session);
}
