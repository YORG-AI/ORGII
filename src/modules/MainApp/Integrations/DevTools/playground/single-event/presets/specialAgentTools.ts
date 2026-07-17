import type { StatusPreset } from "../../types";

export const specialAgentToolPresets: Record<string, StatusPreset[]> = {
  approval_request: [
    {
      key: "pending",
      label: "Pending",
      status: "running",
      resultPatch: { pending: true, approved: null },
    },
    {
      key: "approved",
      label: "Approved",
      status: "completed",
      resultPatch: { pending: false, approved: true },
    },
    {
      key: "denied",
      label: "Denied",
      status: "completed",
      resultPatch: { pending: false, approved: false },
    },
  ],
  suggest_mode_switch: [
    { key: "pending", label: "Pending", status: "running", resultPatch: {} },
    {
      key: "switched",
      label: "Switched",
      status: "completed",
      resultPatch: { switched: true },
    },
    {
      key: "skipped",
      label: "Skipped",
      status: "completed",
      resultPatch: { skipped: true },
    },
  ],
};
