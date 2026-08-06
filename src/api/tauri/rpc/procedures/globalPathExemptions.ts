import { z } from "zod/v4";

import { defineProcedure } from "../invoke";
import * as schemas from "../schemas";

const transformEntry = (raw: unknown) => {
  if (!raw || typeof raw !== "object") return raw;
  const entry = raw as Record<string, unknown>;
  return {
    id: entry.id,
    canonicalPath: entry.canonicalPath ?? entry.canonical_path,
    access: entry.access === "read_write" ? "readWrite" : entry.access,
    recursive: entry.recursive,
    createdAt: entry.createdAt ?? entry.created_at,
    updatedAt: entry.updatedAt ?? entry.updated_at,
  };
};

const transformEntries = (raw: unknown) =>
  Array.isArray(raw) ? raw.map(transformEntry) : raw;

export const globalPathExemptions = {
  list: defineProcedure("global_path_exemptions_list")
    .output(z.array(schemas.globalPathExemptions.EntrySchema))
    .transform(transformEntries)
    .build(),

  add: defineProcedure("global_path_exemptions_add")
    .input(schemas.globalPathExemptions.AddInput)
    .output(schemas.globalPathExemptions.EntrySchema)
    .transform(transformEntry)
    .build(),

  remove: defineProcedure("global_path_exemptions_remove")
    .input(schemas.globalPathExemptions.RemoveInput)
    .output(z.boolean())
    .build(),
} as const;
