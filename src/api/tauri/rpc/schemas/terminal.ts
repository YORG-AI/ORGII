/**
 * Zod schemas for terminal PTY Tauri commands.
 *
 * Mirrors Rust types in src-tauri/src/terminal/pty.rs.
 */
import { z } from "zod/v4";

// ============================================================================
// Value objects
// ============================================================================

export const PtyInfoSchema = z.object({
  session_id: z.string(),
  pid: z.number(),
  cwd: z.string(),
  cols: z.number(),
  rows: z.number(),
  created_at: z.string(),
});

export const PtyMemoryInfoSchema = z.object({
  session_id: z.string(),
  pid: z.number().nullable().optional(),
  shell: z.string(),
  memory_mb: z.number(),
  buffer_bytes: z.number(),
  scrollback_lines: z.number(),
});

// ============================================================================
// Procedure inputs
// ============================================================================

export const CreatePtyInput = z.object({
  request: z.object({
    session_id: z.string(),
    cwd: z.string().optional(),
    cols: z.number().optional(),
    rows: z.number().optional(),
    env: z.record(z.string(), z.string()).optional(),
    shell: z.string().optional(),
    args: z.array(z.string()).optional(),
  }),
});

export const WritePtyInput = z.object({
  sessionId: z.string(),
  data: z.string(),
});

export const ResizePtyInput = z.object({
  request: z.object({
    session_id: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
});

export const ClosePtyInput = z.object({
  sessionId: z.string(),
});

export const CheckPtyExistsInput = z.object({
  sessionId: z.string(),
});

export const GetPtyInfoInput = z.object({
  sessionId: z.string(),
});

// ============================================================================
// Static types
// ============================================================================

export type PtyMemoryInfo = z.infer<typeof PtyMemoryInfoSchema>;
