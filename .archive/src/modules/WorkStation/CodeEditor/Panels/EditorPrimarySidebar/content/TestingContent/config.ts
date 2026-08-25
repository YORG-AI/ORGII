/**
 * TestingPanel Configuration
 */
import {
  CheckCircle,
  Circle,
  FlaskConical,
  Loader,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from "lucide-react";

import type { TestStatus } from "@src/types/testing";

export const ICON_CONFIG = {
  testing: FlaskConical,
  play: Play,
  stop: Square,
  refresh: RefreshCw,
} as const;

export const STATUS_ICONS: Record<TestStatus, typeof Circle> = {
  pending: Circle,
  running: Loader,
  passed: CheckCircle,
  failed: XCircle,
  skipped: Circle,
  errored: XCircle,
} as const;

export const PANEL_CONSTANTS = {
  ICON_SIZE: 14,
  ICON_SIZE_SMALL: 12,
} as const;
