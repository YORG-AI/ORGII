# Shared Layouts

Reusable layout components for the Orgii application.

## Components

### AppLayout

The main application shell used by all routes under `/orgii/*`. Provides:

- Global toolbar (with WebGL Liquid Glass)
- Dynamic sidebar slot
- Floating sidebar (hover-triggered when collapsed)
- Tab bar (conditionally shown)
- Built-in chat panel (for session/editor views)
- Global chat drawer (Cmd+I for other views)
- Global modals

```tsx
import { AppLayout } from "@src/modules/shared/layouts";

<AppLayout
  sidebar={<MySidebar />}
  floatingSidebar={<MyFloatingSidebar />}
  showChatPanel={true}
  showTabBar={true}
  contentPadding={false}
>
  {children}
</AppLayout>;
```

### SplitViewLayout

Two-panel layout with resizable left panel. Used for list/detail views like Settings, Inbox, Usage pages.

```tsx
import { SplitViewLayout } from "@src/modules/shared/layouts";

<SplitViewLayout
  listContent={<ItemList />}
  mainContent={<ItemDetail />}
  listWidth={320}
/>;
```

### MainContentArea

Wrapper with CSS containment for performance isolation. Used internally by AppLayout.

### GlobalModals

Renders app-wide modals (Login, ComponentIssue). Used internally by AppLayout.

## Pages NOT Using These Layouts

| Route          | Component | Reason                  |
| -------------- | --------- | ----------------------- |
| `/orgii/login` | LoginPage | Custom auth design      |
| `/error-page`  | ErrorPage | Must work independently |

## Architecture

```
AppShell (src/modules/index.tsx)
└── AppLayout
    ├── GlobalToolbar (stable, contains WebGL)
    ├── HoverSidebar.Trigger
    ├── Sidebar slot (dynamic per route)
    ├── FloatingSidebar (hover container)
    ├── TabBar (conditional)
    ├── MainContentArea
    │   ├── Content (via Outlet)
    │   ├── ChatPanel (session/editor)
    │   └── GlobalChatPanel (Cmd+I)
    └── GlobalModals
```
