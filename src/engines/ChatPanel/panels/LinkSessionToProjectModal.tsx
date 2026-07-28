import { FolderPlus, Link2, X } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { type ProjectData, projectApi } from "@src/api/http/project";
import { linkSessionToProject } from "@src/api/tauri/agent/session";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { STORY_PERSONAL_ORG_FILTER_ID } from "@src/store/workstation";

interface Props {
  open: boolean;
  sessionId: string | null;
  onClose: () => void;
  onLinked?: () => void;
}

function slugFor(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function LinkSessionToProjectModal({
  open,
  sessionId,
  onClose,
  onLinked,
}: Props) {
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void projectApi
      .readProjects()
      .then(setProjects)
      .catch((error: unknown) => {
        Message.error(error instanceof Error ? error.message : String(error));
      });
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setNewName("");
      setBusy(null);
    }
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? projects.filter((project) =>
          [project.meta.name, project.slug].some((value) =>
            value.toLowerCase().includes(needle)
          )
        )
      : projects;
  }, [projects, query]);

  if (!open) return null;

  const link = async (project: ProjectData) => {
    if (!sessionId) return;
    setBusy(project.slug);
    try {
      await linkSessionToProject({ sessionId, projectSlug: project.slug });
      Message.success("Session linked to project");
      onLinked?.();
      onClose();
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const createAndLink = async () => {
    if (!sessionId || !newName.trim()) return;
    const name = newName.trim();
    const slug = slugFor(name);
    if (!slug) return;
    setBusy("create");
    try {
      const now = new Date().toISOString();
      await projectApi.writeProject(
        slug,
        {
          id: `proj-${slug}`,
          name,
          org_id: STORY_PERSONAL_ORG_FILTER_ID,
          status: "backlog",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: [],
          created_at: now,
          updated_at: now,
          next_work_item_id: 1,
          work_item_prefix: "PRJ",
          work_item_prefix_custom: false,
        },
        "",
        true
      );
      await linkSessionToProject({ sessionId, projectSlug: slug });
      Message.success("Project created and session linked");
      onLinked?.();
      onClose();
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      data-testid="session-link-project-modal"
    >
      <div className="flex max-h-[78vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-solid border-border-1 bg-bg-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-solid border-border-1 px-4 py-3">
          <div>
            <h3 className="m-0 text-[14px] font-semibold">
              Link session to Project
            </h3>
            <p className="m-0 mt-0.5 text-[11px] text-text-3">
              Choose an existing Project or create one for this session.
            </p>
          </div>
          <Button
            variant="tertiary"
            appearance="ghost"
            size="small"
            icon={<X size={15} />}
            onClick={onClose}
            aria-label="Close"
          />
        </div>
        <div className="space-y-3 overflow-y-auto p-4">
          <Input
            value={query}
            onChange={setQuery}
            placeholder="Search projects"
            data-testid="session-link-project-search"
          />
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {matches.map((project) => (
              <button
                key={project.slug}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-fill-2 disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void link(project)}
                data-testid={`session-link-project-option-${project.slug}`}
              >
                <Link2 size={14} />
                <span className="flex-1 truncate">{project.meta.name}</span>
                <span className="text-xs text-text-3">
                  {busy === project.slug ? "Linking…" : project.slug}
                </span>
              </button>
            ))}
            {matches.length === 0 ? (
              <p className="px-3 text-sm text-text-3">No matching projects.</p>
            ) : null}
          </div>
          <div className="border-t border-solid border-border-1 pt-3">
            <p className="m-0 mb-2 text-sm font-medium">Create Project</p>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={setNewName}
                placeholder="Project name"
                data-testid="session-create-project-name"
              />
              <Button
                htmlType="button"
                disabled={!newName.trim() || busy !== null}
                onClick={() => void createAndLink()}
                icon={<FolderPlus size={15} />}
              >
                {busy === "create" ? "Creating…" : "Create & Link"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
