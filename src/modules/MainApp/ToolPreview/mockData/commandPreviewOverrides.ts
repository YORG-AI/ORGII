interface RichCommandPreviewOverride {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

type CommandPreviewOverride =
  | Record<string, unknown>
  | RichCommandPreviewOverride;

const COMMAND_PREVIEW_OVERRIDES: Readonly<
  Record<string, Readonly<Record<string, CommandPreviewOverride>>>
> = {
  read_file: {
    read_image: { path: "docs/screenshots/dashboard.png" },
    read_pdf: { path: "docs/architecture/design-spec.pdf" },
  },
  code_search: {
    grep: {
      action: "grep",
      pattern: "TODO|FIXME|HACK",
      query: "TODO|FIXME|HACK",
    },
    find_files: {
      action: "find_files",
      pattern: "tsconfig",
      query: "tsconfig",
    },
    glob: {
      action: "glob",
      pattern: "src/**/*.test.tsx",
      query: "src/**/*.test.tsx",
    },
    symbols: {
      action: "symbols",
      pattern: "handleSubmit",
      query: "handleSubmit",
    },
    check_status: {
      action: "check_status",
      pattern: undefined,
      query: undefined,
    },
  },
  run_shell: {
    kill: { kill_handle: "bg_3", command: undefined },
  },
  worktree: {
    add: { action: "add", branch: "feature/auth-refactor", base_ref: "main" },
    leave: {
      action: "leave",
      remove: true,
      branch: undefined,
      base_ref: undefined,
    },
    list: { action: "list", branch: undefined, base_ref: undefined },
  },
  manage_workspace: {
    list: { action: "list" },
    add: { action: "add", path: "/Users/developer/Work/new-project" },
    clone: {
      action: "clone",
      url: "https://github.com/YORG-AI/orgii.git",
      target_dir: "/Users/developer/Documents/GitHub",
    },
    create: {
      action: "create",
      name: "fresh-workspace",
      target_dir: "/Users/developer/Work",
      git: true,
    },
    remove: { action: "remove", path: "/Users/developer/Desktop/scratch-pad" },
  },
  manage_story: {
    list: { args: { action: "list" } },
    create: {
      args: {
        action: "create",
        name: "Chat panel CRUD affordances",
        priority: "high",
        status: "planned",
      },
      result: { content: "Created project 'Chat panel CRUD affordances'" },
    },
    update: {
      args: {
        action: "update",
        slug: "chat-panel-visual-polish",
        name: "Chat panel visual polish",
        status: "in_review",
      },
      result: { content: "Updated project 'Chat panel visual polish'" },
    },
    delete: {
      args: { action: "delete", slug: "legacy-project-icons" },
      result: { content: "Deleted project 'Legacy project icons'" },
    },
    find: {
      args: { action: "find", query: "chat panel" },
      result: {
        content: [
          '- [CP-102] "Add CRUD trailing indicators" — project: Chat panel visual polish',
          "- Chat panel visual polish (slug: chat-panel-visual-polish) — in_progress · high",
          '- [CP-105] "Remove legacy action-specific icons" — project: Chat panel visual polish',
        ].join("\n"),
      },
    },
    list_items: {
      args: { action: "list_items", slug: "chat-panel-visual-polish" },
      result: {
        content: [
          "- **Unify project list row style** [CP-101] — completed · high · @frontend",
          "- **Add CRUD trailing indicators** [CP-102] — in_review · high · @frontend",
          "- **Update Built-in Tool Playground fixtures** [CP-103] — in_progress · medium · @frontend",
        ].join("\n"),
      },
    },
  },
  manage_work_item: {
    list: {
      args: { action: "list", project_slug: "chat-panel-visual-polish" },
    },
    list_items: {
      args: { action: "list_items", project_slug: "chat-panel-visual-polish" },
    },
    create: {
      args: {
        action: "create",
        project_slug: "chat-panel-visual-polish",
        title: "Add plus icon for created rows",
        priority: "high",
      },
      result: {
        content: "Created work item 'Add plus icon for created rows' [CP-108]",
      },
    },
    create_item: {
      args: {
        action: "create_item",
        project_slug: "chat-panel-visual-polish",
        title: "Add plus icon for created rows",
        priority: "high",
      },
      result: {
        content: "Created work item 'Add plus icon for created rows' [CP-108]",
      },
    },
    update: {
      args: {
        action: "update",
        project_slug: "chat-panel-visual-polish",
        short_id: "CP-102",
        title: "Add CRUD trailing indicators",
        status: "in_review",
      },
      result: {
        content: "Updated work item 'Add CRUD trailing indicators' [CP-102]",
      },
    },
    update_item: {
      args: {
        action: "update_item",
        project_slug: "chat-panel-visual-polish",
        short_id: "CP-102",
        title: "Add CRUD trailing indicators",
        status: "in_review",
      },
      result: {
        content: "Updated work item 'Add CRUD trailing indicators' [CP-102]",
      },
    },
    delete: {
      args: {
        action: "delete",
        project_slug: "chat-panel-visual-polish",
        short_id: "CP-099",
      },
      result: {
        content: "Deleted work item 'Legacy folder-kanban override' [CP-099]",
      },
    },
    delete_item: {
      args: {
        action: "delete_item",
        project_slug: "chat-panel-visual-polish",
        short_id: "CP-099",
      },
      result: {
        content: "Deleted work item 'Legacy folder-kanban override' [CP-099]",
      },
    },
  },
};

export function resolveCommandPreviewOverride(
  toolName: string,
  commandName: string
): {
  args: Record<string, unknown>;
  result: Record<string, unknown>;
} {
  const override = COMMAND_PREVIEW_OVERRIDES[toolName]?.[commandName];
  return {
    args: getCommandArgsOverride(override),
    result: getCommandResultOverride(override),
  };
}

function getCommandArgsOverride(
  override: CommandPreviewOverride | undefined
): Record<string, unknown> {
  if (!override) return {};
  if (isRichCommandPreviewOverride(override)) return override.args ?? {};
  return override;
}

function getCommandResultOverride(
  override: CommandPreviewOverride | undefined
): Record<string, unknown> {
  if (!override) return {};
  if (isRichCommandPreviewOverride(override)) return override.result ?? {};
  return {};
}

function isRichCommandPreviewOverride(
  override: CommandPreviewOverride
): override is RichCommandPreviewOverride {
  return "args" in override || "result" in override;
}
