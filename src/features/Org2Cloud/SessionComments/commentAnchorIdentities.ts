/**
 * The comments provider only needs event identity for cloud-anchor
 * presence. Token growth on `displayText` must not rebuild that list.
 */

export interface CommentAnchorEventIdentity {
  id: string;
  source?: string;
}

const EMPTY_IDENTITIES: CommentAnchorEventIdentity[] = [];

export function toCommentAnchorIdentities<
  T extends { id: string; source?: string },
>(events: ReadonlyArray<T>): CommentAnchorEventIdentity[] {
  if (events.length === 0) return EMPTY_IDENTITIES;
  return events.map((event) => ({
    id: event.id,
    source: event.source,
  }));
}

export function areCommentAnchorIdentitiesEqual(
  left: readonly CommentAnchorEventIdentity[],
  right: readonly CommentAnchorEventIdentity[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].id !== right[index].id ||
      left[index].source !== right[index].source
    ) {
      return false;
    }
  }
  return true;
}
