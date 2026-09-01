# Contexts Organization

This document describes the organization of the `src/contexts/` folder.

## Structure Overview

```
src/contexts/
├── index.ts                    # Main barrel export
├── git/                        # Git status contexts
├── workstation/                 # Workstation page contexts
├── integration/                # External service contexts
├── session/                    # Session navigation contexts
├── ui/                         # UI state contexts
└── workspace/                  # Workspace-level contexts
```

## Domain Categories

### `git/` - Git Status Contexts

Contexts for git operations and status tracking.

| File                | Contents                                     |
| ------------------- | -------------------------------------------- |
| `GitStatusContext/` | Single-repo git status with deferred loading |

### `workstation/` - Workstation Contexts

Contexts for Workstation pages. Each provides session/state management.

| File                | Contents                     |
| ------------------- | ---------------------------- |
| `AutomationContext` | Automation workflow sessions |
| `BrowserContext`    | Browser tab sessions         |
| `EditorContext`     | Editor repo selection        |
| `FilesContext`      | Document files management    |
| `TerminalContext`   | Terminal sessions            |

### `session/` - Session Contexts

Contexts for session navigation and file tracking.

| File                 | Contents                            |
| -------------------- | ----------------------------------- |
| `RecentFilesContext` | Recent files tracking in editor     |
| `SessionListContext` | Session list for navigation sidebar |

### `ui/` - UI State Contexts

Contexts for UI state management.

| File                  | Contents                       |
| --------------------- | ------------------------------ |
| `ToolbarThemeContext` | Toolbar/tabbar theme decisions |

### `workspace/` - Workspace Contexts

Workspace-level contexts for chat and data.

| File          | Contents                        |
| ------------- | ------------------------------- |
| `ChatContext` | Chat state (partially migrated) |
| `DataContext` | Workspace data state            |

## Import Guidelines

### Direct imports (recommended)

```typescript
import { useGitStatusContext } from "@src/contexts/git";
import { useBrowserContext } from "@src/contexts/workstation";
```

### Namespace imports (when names conflict)

```typescript
import * as GitContexts from "@src/contexts/git";
import * as WorkStationContexts from "@src/contexts/workstation";
```

## Design Principles

1. **Domain-driven**: Contexts grouped by what they manage, not where they're used
2. **Barrel exports**: Each domain has `index.ts` for easy imports
3. **Colocation**: Related contexts stay together (e.g., all Workstation contexts)
4. **Provider pattern**: Each context follows Provider + useContext hook pattern

## Adding New Contexts

1. Identify the domain: Is it for a Human Tool? Git? Integration? UI state?
2. Check for existing files in that domain
3. Add to existing file if related, or create new file if distinct
4. Export from the domain's `index.ts`
5. Add namespace export to main `index.ts` if needed

## Migration Notes

Reorganized on 2026-01-29:

- Moved `GitStatusContext/` → `git/GitStatusContext/`
- Moved `AutomationContext`, `BrowserContext`, `EditorContext`, `FilesContext`, `TerminalContext` → `workstation/`
- Moved `SessionListContext`, `RecentFilesContext` → `session/`
- Moved `ToolbarThemeContext` → `ui/`
- Kept `workspace/` as-is (already organized)

Updated on 2026-03-29:

- Removed `integration/` folder (code-server extension bridge removed)

Updated on 2026-09-01:

- Removed the unused multi-repository Git status context after Spotlight stopped showing repository status badges
