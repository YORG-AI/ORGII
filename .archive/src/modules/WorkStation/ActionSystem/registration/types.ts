/**
 * Registration Types
 *
 * Shared types for action registration functions.
 */
import type { z } from "zod";

import type {
  ActionMeta,
  ZodAction,
} from "@src/ActionSystem/schema/defineZodAction";

/**
 * Action result returned by executors
 */
export interface ActionResult {
  success: boolean;
  message?: string;
  data?: unknown;
}

/**
 * Action executor function signature
 */
export type ActionExecutor<TParams extends z.ZodTypeAny = z.ZodTypeAny> = (
  params: z.infer<TParams>
) => Promise<ActionResult>;

/**
 * Register function signature used by action registration modules
 */
export type RegisterFn = <TParams extends z.ZodTypeAny>(
  action: ZodAction<TParams>
) => void;

/**
 * Action registration module function signature
 */
export type ActionRegistrationFn = (
  register: RegisterFn,
  repoPath: string
) => void;

/**
 * Re-export commonly used types
 */
export type { ActionMeta, ZodAction };
