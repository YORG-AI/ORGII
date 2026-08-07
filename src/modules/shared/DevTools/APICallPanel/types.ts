// ============================================
// Type Definitions
// ============================================
import type {
  ApiCall,
  ApiCallHotspot,
  PushHotspot,
  TimerHotspot,
} from "@src/util/monitoring/apiTracker";

export interface APICallPanelProps {
  visible: boolean;
  apiCalls: ApiCall[];
  hotspots: ApiCallHotspot[];
  timerHotspots: TimerHotspot[];
  pushHotspots: PushHotspot[];
  onClose: () => void;
  onClear: () => void;
}
