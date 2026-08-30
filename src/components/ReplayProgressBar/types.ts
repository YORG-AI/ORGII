export interface ReplayProgressSegment {
  id: string;
  turnNumber: number;
  leftPercent: number;
  widthPercent: number;
  colorIndex: number;
  tooltip: string;
  ariaLabel: string;
  isActive?: boolean;
}
