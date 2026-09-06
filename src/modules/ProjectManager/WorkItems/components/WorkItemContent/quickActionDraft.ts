import type { UpsertQuickActionRequest } from "@src/api/http/project";

interface BuildQuickActionDraftInput {
  id?: string | null;
  orgId: string;
  name: string;
  description?: string;
  target: string | null;
  prompt: string;
  createdBy?: string | null;
}

/**
 * Validate the editable fields while preserving the prompt payload exactly.
 * Prompt whitespace is meaningful content; invocation must never interpolate
 * or normalize it after the user saves the preset.
 */
export function buildQuickActionUpsertRequest({
  id,
  orgId,
  name,
  description = "",
  target,
  prompt,
  createdBy,
}: BuildQuickActionDraftInput): UpsertQuickActionRequest | null {
  const normalizedName = name.trim();
  if (!normalizedName || !prompt.trim() || !target) return null;
  const separator = target.indexOf(":");
  if (separator <= 0 || separator === target.length - 1) return null;
  return {
    id,
    orgId,
    name: normalizedName,
    description,
    targetKind: target.slice(0, separator),
    targetId: target.slice(separator + 1),
    prompt,
    createdBy,
  };
}
