# Util organization

This document describes the organization of the `src/util/` folder — structure, principles, and maintenance notes.

## Organization principles

1. **Purpose-Based Grouping:** Utilities organized by functional area
2. **Clear Naming:** Descriptive file and folder names
3. **No Dead Code:** All files actively maintained
4. **Single Source of Truth:** No duplicate functionality
5. **Type Safety:** Full TypeScript support

---

## 🏗️ Current Folder Structure

```
src/util/
├── core/                        # Core framework utilities
│   ├── init/
│   │   ├── backgroundInit.ts   # Background initialization
│   │   ├── deferredInit.ts     # Deferred initialization
│   │   ├── menuInit.ts         # Menu initialization
│   │   └── themeInit.ts        # Theme initialization
│   ├── state/
│   │   ├── atomTracker.ts      # Jotai atom tracking & debugging
│   │   ├── instrumentedStore.ts # Instrumented Jotai store
│   │   └── windowId.ts         # Storage-safe per-window identity
│   ├── storage/
│   │   ├── backgroundImage.ts   # Background image storage
│   │   ├── cleanup.ts           # Storage cleanup utilities
│   │   ├── devIndexedDBProtection.ts # Dev IndexedDB protection
│   │   ├── diagnosis.ts         # Storage diagnosis tools
│   │   ├── indexedDB.ts         # IndexedDB wrapper
│   │   └── localStorage.ts      # LocalStorage cache
│   ├── error/
│   │   ├── componentIssueTracker.ts # Component error tracking
│   │   └── globalErrorHandler.ts    # Global error handling
│   ├── debounce.ts              # Debounce utilities
│   └── env.ts                   # Environment detection
│
├── session/                     # Session-related utilities
│   ├── formatters.ts           # Session data formatters
│   ├── replay.ts               # Session replay utilities
│   └── sessionId.ts            # Session ID helpers
│
├── workflow/                    # Workflow-related utilities
│   ├── exploreMockData.ts      # Workflow explore mock data
│   ├── formatters.ts           # Workflow formatters
│   └── mockDataConverter.ts    # Mock data conversion
│
├── editor/                      # Editor-related utilities
│   ├── cursorHistory.ts        # Cursor history parsing
│   └── extension.tsx           # File extension to language mapping
│
├── git/                         # Git-related utilities
│   ├── helpers.ts              # Git helper functions
│   └── computeSuggestedAction.ts # Git action suggestions
│
├── filesync/                    # File synchronization utilities
│   ├── index.ts                # Main file sync exports
│   ├── chunkAssembler.ts       # Chunk assembly
│   ├── deletionTracker.ts      # Deletion tracking
│   ├── ignoreFilter.ts         # Ignore filter
│   ├── lastWriteWinsResolver.ts # Conflict resolution
│   ├── pathNormalizer.ts       # Path normalization
│   └── syncLoopGuard.ts        # Sync loop prevention
│
├── cache/                       # Caching utilities
│   └── lruCache.ts             # LRU cache implementation
│
├── api/                         # API utilities
│   └── batchRequest.ts         # Batch request handling
│
├── diff/                        # Diff utilities
│   ├── index.ts                # Diff utilities exports
│   └── parseUnifiedDiff.ts     # Unified diff parsing
│
├── language/                    # Language detection
│   ├── index.ts                # Language utilities exports
│   ├── detectLanguage.ts       # Language detection
│   └── languageMap.ts          # Language mapping
│
├── ui/                          # UI utilities
│   ├── theme/
│   │   ├── glassMaterial.ts    # Glass material theme resolver
│   │   ├── themeUtils.ts       # Theme utility functions
│   │   └── toolbarTheme.ts     # Toolbar theme resolver
│   ├── tabs/
│   │   └── tabHelpers.ts       # Tab helper functions
│   ├── terminal/
│   │   ├── naming.ts           # Terminal naming utilities
│   │   └── themes.ts           # Terminal themes
│   ├── menu/
│   │   └── menuManager.ts      # Menu management
│   ├── message/
│   │   ├── messageUtil.ts      # Message utilities
│   │   └── workStatus.ts       # Work status manager
│   ├── window/
│   │   └── windowManager.ts    # Window management
│   ├── rendering/
│   │   ├── breadcrumb.tsx      # Breadcrumb rendering
│   │   ├── chatDetail.ts       # Chat detail creation
│   │   ├── eventHeader.tsx     # Event header rendering
│   │   ├── getEventDescription.ts # Event description generation
│   │   ├── getAppNameFromAppType.ts # App name from app type
│   │   └── getAppNameFromToolType.ts # App name from tool type
│   └── classNames.ts           # ClassName utilities
│
├── data/                        # Data transformation utilities
│   ├── converters/
│   │   ├── eventPayload.ts     # Event payload conversion
│   │   └── eventStatus.ts      # Event status conversion
│   ├── formatters/
│   │   └── date.ts             # Date/time formatting (consolidated)
│   ├── search/
│   │   └── searchFileKeyword.ts # File search keywords
│   └── clipboard.ts            # Clipboard utilities
│
├── platform/                    # Platform-specific utilities
│   ├── tauri/
│   │   ├── events.ts           # Tauri event handling
│   │   ├── fileSearch.ts       # Tauri file search
│   │   ├── index.ts            # Main Tauri utilities
│   │   └── init.ts             # Tauri initialization
│   └── extension/
│       ├── shareData.ts        # Extension data sharing
│       └── websocket.ts        # Extension WebSocket
│
├── monitoring/                  # Monitoring & analytics
│   ├── apiTracker.ts           # API call tracking
│   ├── backendMockDataLoader.ts # Backend mock data loader
│   └── behaviorAnalytics.ts    # User behavior analytics
│
│   # Logging lives at @src/hooks/logger — single facade for devtools
│   # gating + ~/.orgii/logs/frontend.log persistence via the
│   # `write_frontend_log` Tauri command.
│
├── optimization/                # Performance utilities
│   └── imageOptimizer.ts      # Image optimization
│
├── config/                      # Configuration utilities
│   ├── componentMapping.ts     # Component mapping config
│   └── headers.ts              # HTTP headers config
│
└── file/                        # File utilities
    └── pathUtils.ts            # Path utilities
```

---

## ✅ Recently Completed Cleanup (Dec 26, 2025)

### Files Deleted (4 total)

**Deprecated re-export files:**

1. ✅ `data/formatters/dayjsAdaptArea.ts` → Consolidated into `date.ts`
2. ✅ `data/formatters/time.ts` → Consolidated into `date.ts`
3. ✅ `data/formatters/timestamp.ts` → Consolidated into `date.ts`

**Reorganized files:** 4. ✅ `findLastInObject.ts` → Moved to `session/stepFormatters.ts`

### Functions Removed (4 deprecated)

From `ui/tabs/tabHelpers.ts`:

- ✅ `isStartPageTab()` → Use `isStartPage()` from `@src/config/tabTypes`
- ✅ `isHomeTab()` → Use `isStartPage()`
- ✅ `isFixedTab()` → Concept removed
- ✅ `canCloseTab()` → Use `isTabClosable(tab, totalTabs)`

### New Files Created

- ✅ `session/stepFormatters.ts` - Properly organized session utilities

---

## 📊 File Statistics

| Category         | Count        | Description                                              |
| ---------------- | ------------ | -------------------------------------------------------- |
| **Core**         | 13 files     | Framework initialization, state, storage, error handling |
| **Session**      | 3 files      | Session data processing and formatting                   |
| **Workflow**     | 3 files      | Workflow data handling                                   |
| **Editor**       | 2 files      | Editor-related utilities                                 |
| **Git**          | 2 files      | Git operations                                           |
| **File Sync**    | 6 files      | File synchronization utilities                           |
| **Cache**        | 1 file       | Caching utilities                                        |
| **API**          | 1 file       | API utilities                                            |
| **Diff**         | 2 files      | Diff parsing utilities                                   |
| **Language**     | 3 files      | Language detection                                       |
| **UI**           | 18 files     | UI components and theming                                |
| **Data**         | 4 files      | Data transformation and formatting                       |
| **Platform**     | 6 files      | Platform-specific (Tauri, Extension)                     |
| **Monitoring**   | 4 files      | Analytics and tracking                                   |
| **Optimization** | 1 file       | Performance utilities                                    |
| **Config**       | 2 files      | Configuration management                                 |
| **File**         | 1 file       | File utilities                                           |
| **Total**        | **72 files** | All actively maintained                                  |

---

## 🎯 Import Guidelines

### Direct Imports (Recommended)

```typescript
// ✅ Direct imports - clear and explicit
import { isStartPage } from "@src/config/tabTypes";
import { formatDate } from "@src/util/data/formatters/date";
// Note: moved from tabHelpers
import { trackApiCall } from "@src/util/monitoring/apiTracker";
import { handleEvents, handleSteps } from "@src/util/session/stepFormatters";
```

### Namespace Imports (Optional)

```typescript
// ✅ Namespace imports - for multiple functions
import * as DataFormatters from "@src/util/data/formatters";
import * as SessionUtils from "@src/util/session";

const formattedSteps = SessionUtils.handleSteps(steps);
const formattedDate = DataFormatters.formatDate(date);
```

### ❌ Deprecated Imports (Do Not Use)

```typescript
// ❌ These files no longer exist
import { timeAgo } from "@src/util/data/formatters/dayjsAdaptArea";
import { formatDateTime } from "@src/util/data/formatters/timestamp";
import { handleSteps } from "@src/util/findLastInObject";
// ❌ These functions no longer exist
import {
  canCloseTab,
  isFixedTab,
  isHomeTab,
} from "@src/util/ui/tabs/tabHelpers";
```

---

## 📚 Key Utilities Reference

### Core Utilities

#### State Management

- **`atomTracker.ts`** - Debug and track Jotai atom updates
- **`instrumentedStore.ts`** - Performance-instrumented Jotai store
- **`windowId.ts`** - Storage-safe per-window identity

#### Storage

- **`indexedDB.ts`** - IndexedDB persistence layer
- **`localStorage.ts`** - LocalStorage caching utilities
- **`cleanup.ts`** - Storage cleanup and maintenance

#### Initialization

- **`themeInit.ts`** - Theme initialization on app start
- **`menuInit.ts`** - Menu system initialization
- **`deferredInit.ts`** - Deferred non-critical initialization

### Session Utilities

- **`formatters.ts`** - Session data formatters
- **`sessionId.ts`** - Session ID extraction and validation
- **`replay.ts`** - Session replay utilities

### File Sync Utilities

- **`filesync/index.ts`** - Main file sync exports
- **`chunkAssembler.ts`** - Assemble file chunks
- **`deletionTracker.ts`** - Track file deletions
- **`ignoreFilter.ts`** - Filter ignored files
- **`lastWriteWinsResolver.ts`** - Resolve sync conflicts
- **`pathNormalizer.ts`** - Normalize file paths
- **`syncLoopGuard.ts`** - Prevent sync loops

### Cache Utilities

- **`cache/lruCache.ts`** - LRU (Least Recently Used) cache implementation

  ```typescript
  import { LRUCache } from "@src/util/cache/lruCache";

  const cache = new LRUCache<string, Data>({ maxSize: 100 });
  cache.set("key", data);
  const value = cache.get("key");
  ```

### API Utilities

- **`api/batchRequest.ts`** - Batch API request handling

### Diff Utilities

- **`diff/parseUnifiedDiff.ts`** - Parse unified diff format
- **`diff/index.ts`** - Diff utilities exports

### Language Utilities

- **`language/detectLanguage.ts`** - Detect programming language from file
- **`language/languageMap.ts`** - Language mapping configuration
- **`language/index.ts`** - Language utilities exports

### Data Utilities

- **`data/formatters/date.ts`** - All date/time formatting (consolidated)

  ```typescript
  import {
    formatDate,
    formatDateTime,
    fromNow,
    timeAgo,
  } from "@src/util/data/formatters/date";
  ```

- **`data/converters/eventPayload.ts`** - Event payload transformation
- **`data/converters/eventStatus.ts`** - Event status conversion

### UI Utilities

- **`ui/tabs/tabHelpers.ts`** - Tab operations and queries

  ```typescript
  // ✅ Use these
  // ✅ Tab state checks moved to config
  import { isStartPage, isTabClosable } from "@src/config/tabTypes";
  import {
    canMoveTab,
    findTab,
    tabMatches,
  } from "@src/util/ui/tabs/tabHelpers";
  ```

- **`ui/rendering/`** - Event rendering utilities
  - **`eventHeader.tsx`** - Event header rendering
  - **`getEventDescription.ts`** - Generate event descriptions
  - **`getAppNameFromAppType.ts`** - Get app name from app type
  - **`getAppNameFromToolType.ts`** - Get app name from tool type
  - **`breadcrumb.tsx`** - Breadcrumb rendering
  - **`chatDetail.ts`** - Chat detail creation

- **`ui/theme/glassMaterial.ts`** - Glass material theme resolution
- **`ui/window/windowManager.ts`** - Window management operations

### Platform Utilities

- **`platform/tauri/`** - Tauri-specific operations
  - `fileSearch.ts` - Native file search
  - `events.ts` - Tauri event handling
- **`platform/extension/`** - VS Code extension integration
  - `websocket.ts` - Extension WebSocket communication

### Logging Utilities

Logging lives at **`@src/hooks/logger`** (not under `util/`). It is the
single facade for both devtools output (level-gated) and file persistence
(`~/.orgii/logs/frontend.log` via the `write_frontend_log` Tauri command —
the only live backend channel; `tauri-plugin-log` was removed).

```typescript
import {
  LogLevel,
  createLogger,
  log,
  logRateLimited,
  setLogLevel,
} from "@src/hooks/logger";

// Top-level helpers (namespace-first, variadic)
log("namespace", "Message:", data);

// Rate-limited logging (max once per interval)
logRateLimited("unique-key", 60_000, "namespace", "Message");

// Namespaced logger (preferred for any module with more than 1 call site)
const logger = createLogger("myFeature");
logger.info("Started");
logger.warn("recoverable:", err);
logger.error("fatal", err);
logger.critical("never-suppressed: backend unreachable");
logger.rateLimited("status-key", 60_000, "Status update");
logger.perfStart("load");
/* … */ logger.perfEnd("load");

// Runtime level control (default: DEBUG in dev, WARN in prod)
setLogLevel(LogLevel.INFO);
```

**Features:**

- **Single level gate:** one `currentLevel` controls both devtools display
  and file persistence; defaults to `DEBUG` in dev and `WARN` in prod.
  Override at runtime with `setLogLevel(LogLevel.X)` or via the URL flag
  `?debug=true`.
- **Global console interceptor:** `initializeLogging()` (called from
  `index.tsx` synchronously) routes every native `console.*` call through
  the same gate, so third-party libs and ad-hoc `console.log`s participate.
- **Backend persistence:** every emitted line is written to
  `~/.orgii/logs/frontend.log` via `invoke("write_frontend_log", …)`.
- **Rate Limiting:** prevent console flooding with frequent updates.
- **Namespaced Loggers:** create scoped loggers for features.
- **Performance Tracking:** built-in `perfStart()` / `perfEnd()`.
- **Levels:** `trace`, `debug`, `info`/`log`, `warn`, `error`, plus
  `critical` (bypasses the gate; reserved for unrecoverable errors).
- **Styled Output:** custom CSS styling for log badges via `logger.styled`.

**Rate Limiting Example:**

```typescript
// In a hook that updates frequently (e.g., git status watcher)
import { logRateLimited } from "@src/hooks/logger";

// Only logs once per minute, even if called 100 times
logRateLimited(
  "git-watcher-update", // Unique key
  60000, // 60 seconds
  "useRepoManager", // Namespace
  "Rust watcher triggered" // Message
);
```

---

## 🔍 Migration Examples

### Example 1: Date Formatting

```typescript
// ❌ Before (deprecated files)
import { timeAgo } from "@src/util/data/formatters/dayjsAdaptArea";
import { formatDateTime } from "@src/util/data/formatters/timestamp";

// ✅ After (consolidated)
import {
  timeAgo,
  formatDateTime,
} from "@src/util/data/formatters/date";
```

### Example 2: Session Formatters

```typescript
// ❌ Before (poorly organized)
import { handleEvents, handleSteps } from "@src/util/findLastInObject";

// ✅ After (properly organized)
import { handleEvents, handleSteps } from "@src/util/session/stepFormatters";
```

### Example 3: Tab Helpers

```typescript
// ❌ Before (deprecated functions)
import { isHomeTab, isFixedTab, canCloseTab } from "@src/util/ui/tabs/tabHelpers";

if (isHomeTab(tab)) { ... }
if (canCloseTab(tab)) { ... }

// ✅ After (use config/tabTypes)
import { isStartPage, isTabClosable } from "@src/config/tabTypes";

if (isStartPage(tab)) { ... }
if (isTabClosable(tab, totalTabs)) { ... }
```

---

## 🚀 Future Cleanup Opportunities

### Files to Review

1. **`monitoring/backendMockDataLoader.ts`**
   - Current: Actively used in ActivitySimulator
   - Consider: Move to `/mocks` folder if test-only

2. **`config/componentMapping.ts`**
   - Current: 1 import (ModalComponentIssue)
   - Consider: Review after modal architecture updates

3. **`data/search/searchFileKeyword.ts`**
   - Current: 1 import (useInputMessage)
   - Consider: Merge into search utilities

### Previously Cleaned Up ✅

These were removed in earlier refactoring:

- ✅ Tree utilities (addNodesToTree, getNewTreeData, searchTreeData)
- ✅ LinkDifferentSections folder
- ✅ Unused formatting (formatFileSize, numberFormat)
- ✅ Platform detection (webviewDetection, tauriWebview)
- ✅ Old initialization (appInitializer, extensionEvent)

---

## 📝 Maintenance Guidelines

### Adding New Utilities

1. **Choose the Right Folder**
   - Session-related → `session/`
   - UI components → `ui/`
   - Data transformation → `data/`
   - Platform-specific → `platform/`

2. **Naming Conventions**

   ```typescript
   // ✅ Good names (descriptive, clear purpose)
   stepFormatters.ts;
   activityConverter.ts;
   sessionId.ts;

   // ❌ Bad names (vague, unclear)
   helpers.ts;
   utils.ts;
   misc.ts;
   ```

3. **File Size Limits**
   - Keep files under 500 lines
   - Split large files by function (use sub-folders)

4. **Documentation Requirements**
   ````typescript
   /**
    * Brief description of what this utility does
    *
    * Features:
    * - Feature 1
    * - Feature 2
    *
    * @example
    * ```typescript
    * import { myFunction } from '@src/util/category/file';
    * const result = myFunction(input);
    * ```
    */
   ````

### Deprecating Utilities

1. **Mark as deprecated with JSDoc**

   ```typescript
   /**
    * @deprecated Use newFunction from @src/util/new/location instead
    */
   export function oldFunction() { ... }
   ```

2. **Create re-export file temporarily**

   ```typescript
   /**
    * @deprecated Consolidated into newFile.ts
    */
   export { newFunction as oldFunction } from "@src/util/new/location";
   ```

3. **Update all imports** (use global find/replace)

4. **Delete deprecated file** after no usages remain

### Refactoring Checklist

- [ ] Identify deprecated/poorly organized utilities
- [ ] Check usage count (use grep)
- [ ] Create new properly-organized files
- [ ] Update all import paths
- [ ] Run linter and type check
- [ ] Test affected functionality
- [ ] Delete old files
- [ ] Update documentation

---

## 🎯 Best Practices

### 1. Single Responsibility

```typescript
// ✅ Good - each file has clear purpose
util / session / stepFormatters.ts; // Only step/event formatting
util / session / sessionId.ts; // Only session ID handling
util / session / replay.ts; // Only replay utilities

// ❌ Bad - mixed responsibilities
util / session / helpers.ts; // What kind of helpers?
```

### 2. Avoid Duplication

```typescript
// ✅ Good - single source of truth
util / data / formatters / date.ts; // ALL date formatting here

// ❌ Bad - duplicate functionality
util / data / formatters / date.ts;
util / data / formatters / time.ts; // Also has date formatting
util / data / formatters / timestamp.ts; // Also has date formatting
```

### 3. Clear Naming

```typescript
// ✅ Good names
stepFormatters.ts; // Formats steps
activityConverter.ts; // Converts activities
sessionId.ts; // Handles session IDs

// ❌ Bad names
utils.ts; // Too vague
helpers.ts; // Too generic
misc.ts; // No clear purpose
```

### 4. Proper Organization

```typescript
// ✅ Good - organized by purpose
util / session / stepFormatters.ts; // Session-specific
data / formatters / date.ts; // Data formatting

// ❌ Bad - flat structure
util / formatSteps.ts; // Where does this belong?
formatDate.ts; // Related to formatSteps?
```

---

## 📊 Cleanup Impact Summary

### Before Cleanup

- 62 files (including 4 deprecated)
- 4 deprecated functions
- Inconsistent organization
- Duplicate functionality (3 date formatter files)

### After Cleanup

- 59 active files (all maintained)
- 0 deprecated functions
- Clear organization by purpose
- Single source of truth for all utilities
- ✨ Rate-limited logging added (Dec 28, 2025)

### Metrics

| Metric               | Before | After | Improvement |
| -------------------- | ------ | ----- | ----------- |
| Total files          | 62     | 58    | ↓ 6.5%      |
| Deprecated files     | 4      | 0     | ↓ 100%      |
| Deprecated functions | 4      | 0     | ↓ 100%      |
| Date formatter files | 4      | 1     | ↓ 75%       |
| Root-level files     | 2      | 0     | ↓ 100%      |
| Linter errors        | 0      | 0     | ✅ Clean    |

---

## Related documentation

- **Hooks:** `src/hooks/` has no organization doc. Placement rules (2026-08-15,
  after `hooks/workStation` was dissolved):
  1. A hook with one consuming area lives next to that consumer — in the module's
     own `hooks/` dir (`modules/WorkStation/CodeEditor/hooks/`,
     `modules/WorkStation/Browser/hooks/`, `features/SessionSetup/hooks/`, …),
     or beside the single file that uses it.
  2. `src/hooks/<group>/` is only for hooks consumed from several areas
     (e.g. `hooks/tabHost/` — the workstation tab-host contract used by
     WorkStation, ProjectManager, MainApp, features and engines). Never name a
     global group after a module.
  3. No barrels: import the file, not an `index.ts` (barrels hide who really
     depends on what — that is how `hooks/workStation` drifted).
  4. Shared _contracts_ a hook implements go in `src/types/`, so `store/` and
     `services/` never import from `src/hooks/`.
     `.eslintrc.js` `no-restricted-imports` blocks the dissolved paths.
- **Store:** `src/store/store-organization.md`
- **API:** `src/api/api_organization.md`

---

## ✅ Verification

- [x] All files actively maintained (no dead code)
- [x] Clear folder structure by purpose
- [x] No deprecated functions or files
- [x] Single source of truth for all utilities
- [x] Comprehensive documentation
- [x] Zero linter errors
- [x] TypeScript compilation passes

---

**Status:** ✅ Well-organized and actively maintained  
**Last Cleanup:** Dec 26, 2025  
**Latest Addition:** Rate-limited logging (Dec 28, 2025)  
**Last Updated:** January 17, 2025  
**Next Review:** As needed during feature development

---

## History

| Date       | Author | Change                                                          |
| ---------- | ------ | --------------------------------------------------------------- |
| 2026-01-17 | —      | Original V1 document                                            |
| 2026-03-12 | script | Migrated to Documentation V2 format                             |
| 2026-03-25 | —      | Moved to `src/util/util-organization.md`; related links updated |
| 2026-08-15 | —      | Hooks placement rules added; `hooks/workStation` dissolved      |
