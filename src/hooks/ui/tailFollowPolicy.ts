export const DEFAULT_TAIL_FOLLOW_THRESHOLD_PX = 48;

export interface PhysicalScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function getPhysicalScrollBottom(
  metrics: Pick<PhysicalScrollMetrics, "scrollHeight" | "clientHeight">
): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

export function getPhysicalDistanceFromBottom(
  metrics: PhysicalScrollMetrics
): number {
  return getPhysicalScrollBottom(metrics) - Math.max(0, metrics.scrollTop);
}

export function isWithinTailFollowThreshold(
  distanceFromBottom: number,
  threshold = DEFAULT_TAIL_FOLLOW_THRESHOLD_PX
): boolean {
  return distanceFromBottom <= threshold;
}
