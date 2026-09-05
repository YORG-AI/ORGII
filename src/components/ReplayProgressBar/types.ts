export interface ReplayProgressSegment {
  id: string;
  turnNumber: number;
  leftPercent: number;
  tooltip: string;
  ariaLabel: string;
  isActive?: boolean;
}
