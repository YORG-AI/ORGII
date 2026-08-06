import { z } from "zod/v4";

export const AddInput = z.object({ path: z.string() });
export const RemoveInput = z.object({ id: z.string() });

export const EntrySchema = z.object({
  id: z.string(),
  canonicalPath: z.string(),
  access: z.literal("readWrite"),
  recursive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type GlobalPathExemption = z.output<typeof EntrySchema>;
