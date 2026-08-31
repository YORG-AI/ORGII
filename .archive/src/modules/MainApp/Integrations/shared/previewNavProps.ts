/**
 * Shared navigation props for split-view preview panels.
 * All preview panels that participate in prev/next navigation
 * extend these props and forward them to DetailHeaderClose.
 */
export interface PreviewNavProps {
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}
