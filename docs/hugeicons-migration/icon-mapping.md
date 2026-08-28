# Hugeicons migration — icon mapping

Generated from `@hugeicons/core-free-icons@4.3.0` (6,025 icons) against the
425 distinct `lucide-react@0.563.0` icons used in `src/`.

**Every target in this document was validated to exist** as a real module at
`@hugeicons/core-free-icons/dist/esm/<Target>.js`. Nothing here is guessed from
the icon browser.

## How to read this

Each row maps a lucide identifier to a **canonical hugeicons file name**. Use
the canonical name in a named import from the house barrel, `src/icons.ts`:

```ts
import { HugeiconsIcon, Search01Icon } from "@src/icons";
```

The house barrel — not the vendor barrel — is the import style. The vendor
barrel (`@hugeicons/core-free-icons`) is 672 KB across 14,716 exports and
webpack parses all of it on a cold build; `src/icons.ts` re-exports only the
glyphs this app uses, and webpack.config.js flags it `sideEffects: false`, so
webpack links every importer straight to the per-icon deep module. Emitted
bundles are identical to hand-written deep imports, in dev and production.
If a glyph is missing from the barrel, add one re-export line to
`src/icons.ts` (keep the list alphabetical).

## API change

Hugeicons ships icons as **data**, not components. Every call site changes shape:

```diff
-import { Search } from "lucide-react";
-<Search size={16} className="text-text-3" />
+import { HugeiconsIcon, Search01Icon } from "@src/icons";
+<HugeiconsIcon icon={Search01Icon} size={16} className="text-text-3" />
```

`HugeiconsIcon` forwards `className`, `ref`, and all SVG props, and accepts
`size`, `strokeWidth`, `absoluteStrokeWidth`, `color`.

## Counts

| category                    |   icons | meaning                                                                                          |
| --------------------------- | ------: | ------------------------------------------------------------------------------------------------ |
| Vendor alias                |     402 | hugeicons' own barrel already maps the lucide name; the mapping is the vendor's choice, not ours |
| Manual                      |      22 | no vendor alias; resolved by hand against the export list                                        |
| — of which flagged `REVIEW` |       5 | defensible but visually imperfect; needs a human look                                            |
| Hand-port                   |       1 | `createLucideIcon` — a custom glyph, no equivalent                                               |
| **Total**                   | **425** |                                                                                                  |

## Known behavioral differences

These apply repo-wide and are **not** captured per-row.

1. **Stroke weight — the app ships at hugeicons' native 1.5.** Lucide defaulted
   to `strokeWidth={2}`; hugeicons bakes `1.5` into its path data and overrides
   it only when `strokeWidth` is passed. **This was a deliberate decision**: the
   app is intentionally lighter than it was under lucide. Do not "fix" it by
   adding `strokeWidth={2}` to new call sites.

   The 215 explicit `strokeWidth` values that pre-dated the migration are
   preserved exactly, including the 414 sites at `1.75` — which is this repo's
   actual house weight — and the outliers at `1.8`, `1.9`, `2.25`, and `0`
   (the solid media controls).

2. **Same name, different drawing.** A vendor alias means the _name_ matches,
   not the artwork. Hugeicons `Cancel01Icon` (lucide `X`) is a 2-stroke cross;
   the separate `XIcon` file is a 4-ray cross. Name parity is not visual parity.
3. **No filled variants — but nothing in this repo needed them.** The free tier
   is Stroke Rounded only. An earlier draft of this document claimed the status
   indicators (`CheckCircle2`, `XCircle`, `CircleDot`, `Circle`) would regress
   to outlines. That was wrong: lucide's own `CheckCircle2` is two stroke paths
   with no fill, and **zero** of those call sites passed `fill`. They were
   already outlines. There is no regression and no reason to buy Pro over this.
4. **`fill="currentColor"` still works.** Eleven sites use it; three are
   hand-authored SVGs unrelated to lucide (`PanelIcons`, `AppMark`, a Gantt
   arrowhead). The remaining seven are solid media controls —
   `<Play|Pause|Square fill="currentColor" strokeWidth={0} />` — and they render
   correctly under hugeicons: `HugeiconsIcon` forwards `fill` to the `<svg>`
   (overriding its `fill: none` default) and applies `strokeWidth={0}`, and the
   `PlayIcon` / `PauseIcon` / `SquareIcon` glyphs are closed paths, so they fill
   solid. Verified by server-rendering the component, not by inspection.
5. **Icon identity in the DOM (`data-icon`).** Lucide stamped
   `class="lucide lucide-chevron-down"` onto every icon it rendered, and about
   fifty assertions across the unit suite plus four e2e selectors came to rely
   on it. `HugeiconsIcon` stamps nothing. Rather than delete those assertions,
   every static call site now carries `data-icon="<kebab-name>"`, applied by
   a one-shot codemod (since removed). It is one attribute where lucide
   wrote two classes, so the rendered DOM is lighter than before.

   **Keep new call sites consistent**: when you add an icon that a test needs to
   identify, add `data-icon`. Dynamic sites (`icon={item.icon}`) have no name
   available and are deliberately left unstamped — pass one explicitly if a test
   needs to distinguish them.

6. **Glyph data is a valid `ReactNode`.** This is the sharpest edge in the whole
   migration. `IconSvgElement` is a nested array, and arrays satisfy
   `ReactNode`, so any prop typed `icon: ReactNode` accepts glyph data and
   **typechecks clean** — then React throws
   `Element type is invalid ... but got: object` at runtime. A green
   `tsc --noEmit` does not prove icon rendering is correct here; the unit suite
   does. Two forms of this shipped past the typechecker during the migration:
   `createElement(Glyph, props)` (103 sites) and
   `const Icon = config.icon; <Icon />` (5 sites).
   `scripts/hugeicons/find-glyph-as-component.mjs` detects both forms with the
   TypeScript checker (run it manually; it exits non-zero on any hit), and
   the `no-restricted-syntax` glyph-cast guards in `.eslintrc.js` block the
   casts that used to hide them.

7. **`LucideIcon` type.** 227 references across 89 files type icons as React
   _components_. Under hugeicons they are `IconSvgElement` _data_, so every
   registry (`config/toolIcons.tsx`, `config/iconMapping.ts`,
   `config/agentIcons.tsx`, `components/PanelIcons.tsx`,
   `NavigationSidebar/utils/renderIcon.tsx`) and all of its consumers change.

## Historical bindings (lucide name → hugeicons glyph)

Each row is the lucide-era local name a call site used at migration time and
the hugeicons glyph it resolved to. Call sites have since been renamed to the
canonical hugeicons names (a few icon-id registries keep lucide-era locals via
`import { Glyph as Local }` aliases), so this table is a lookup — "I knew the
lucide name, which glyph is it now?" — not a description of current code.
`data-icon` values still use the lucide-era kebab names; tests assert on them.

Many bindings were changed by eye after seeing them rendered, overriding what
the vendor alias table produced. The notable ones:

- **Arrows vs chevrons.** Hugeicons aliases _both_ `ChevronUp` and `ArrowUp`
  onto `ArrowUp01Icon`, a single curved path with no shaft. 66 sites meaning
  "arrow" were drawing carets. `Arrow*` now uses the `02` glyphs (real shaft);
  `Chevron*` keeps the `01` glyphs.
- **Collapsed aliases restored.** 45 mappings had several distinct lucide names
  flattened onto one target while hugeicons shipped a same-named glyph —
  `CircleDot` became a plain circle (the dot vanished), and `ListTodo` /
  `ListChecks` / `ClipboardList` all became one `CheckListIcon`. Each now uses
  its exact-name glyph.
- **Corner/return direction.** `CornerDownLeft` and `CornerDownRight` both
  mapped to a generic U-turn; the directional glyphs exist and are now used.
- Branch, refresh, folder, browser, external-link, dashboard, edit, send and the
  sidebar filter were all retargeted to specific requested glyphs.

| local name                   | hugeicons glyph                  | imports |
| ---------------------------- | -------------------------------- | ------: |
| `X`                          | `Cancel01Icon`                   |     101 |
| `ChevronRight`               | `ArrowRight01Icon`               |      92 |
| `RefreshCw`                  | `Refresh04Icon`                  |      85 |
| `Plus`                       | `Add01Icon`                      |      80 |
| `Check`                      | `Tick01Icon`                     |      75 |
| `ChevronDown`                | `ArrowDown01Icon`                |      69 |
| `Search`                     | `Search01Icon`                   |      64 |
| `Trash2`                     | `Delete02Icon`                   |      55 |
| `Loader2`                    | `Loading03Icon`                  |      52 |
| `SquareArrowOutUpRight`      | `SquareArrowUpRightIcon`         |      43 |
| `CheckCircle2`               | `CheckmarkCircle01Icon`          |      41 |
| `Copy`                       | `CopyIcon`                       |      39 |
| `GitBranch`                  | `WorkflowCircle05Icon`           |      38 |
| `Code`                       | `CodeIcon`                       |      29 |
| `XCircle`                    | `CancelCircleIcon`               |      29 |
| `Folder`                     | `FolderClosedIcon`               |      27 |
| `Terminal`                   | `ComputerTerminal01Icon`         |      27 |
| `Circle`                     | `CircleIcon`                     |      26 |
| `CircleDot`                  | `CircleDotIcon`                  |      26 |
| `GitPullRequest`             | `GitPullRequestIcon`             |      26 |
| `Globe`                      | `InternetIcon`                   |      26 |
| `Clock`                      | `Clock01Icon`                    |      23 |
| `Pencil`                     | `Pen01Icon`                      |      23 |
| `ChevronLeft`                | `ArrowLeft01Icon`                |      22 |
| `Box`                        | `BoxIcon`                        |      21 |
| `ChevronsUpDown`             | `UnfoldMoreIcon`                 |      21 |
| `ArrowLeft`                  | `ArrowLeft02Icon`                |      20 |
| `Info`                       | `InformationCircleIcon`          |      19 |
| `Lock`                       | `LockIcon`                       |      19 |
| `Minus`                      | `MinusSignIcon`                  |      19 |
| `MoreHorizontal`             | `MoreHorizontalIcon`             |      19 |
| `User`                       | `UserIcon`                       |      19 |
| `Users`                      | `UserMultipleIcon`               |      19 |
| `AlertCircle`                | `AlertCircleIcon`                |      18 |
| `ArrowUp`                    | `ArrowUp02Icon`                  |      18 |
| `ChevronsDownUp`             | `ChevronsDownUpIcon`             |      18 |
| `FolderOpen`                 | `FolderOpenIcon`                 |      18 |
| `ListChecks`                 | `ListChecksIcon`                 |      18 |
| `ListTodo`                   | `ListTodoIcon`                   |      18 |
| `Play`                       | `PlayIcon`                       |      18 |
| `AlertTriangle`              | `Alert01Icon`                    |      17 |
| `Sparkles`                   | `SparklesIcon`                   |      17 |
| `ArrowRight`                 | `ArrowRight02Icon`               |      16 |
| `Network`                    | `AiNetworkIcon`                  |      16 |
| `Bot`                        | `BotIcon`                        |      15 |
| `Hash`                       | `HashtagIcon`                    |      15 |
| `Cloud`                      | `CloudIcon`                      |      14 |
| `FileText`                   | `File02Icon`                     |      14 |
| `GitMerge`                   | `GitMergeIcon`                   |      14 |
| `Layout`                     | `Layout01Icon`                   |      14 |
| `MessageCircle`              | `BubbleChatIcon`                 |      14 |
| `MessageSquare`              | `Message01Icon`                  |      14 |
| `RotateCcw`                  | `RotateLeft01Icon`               |      14 |
| `ArrowDown`                  | `ArrowDown02Icon`                |      13 |
| `BookOpen`                   | `BookOpen01Icon`                 |      13 |
| `Layers`                     | `Layers01Icon`                   |      13 |
| `Maximize2`                  | `ArrowExpand01Icon`              |      13 |
| `Settings`                   | `Settings01Icon`                 |      13 |
| `Eye`                        | `ViewIcon`                       |      12 |
| `Inbox`                      | `InboxIcon`                      |      12 |
| `Calendar`                   | `Calendar01Icon`                 |      11 |
| `Download`                   | `Download01Icon`                 |      11 |
| `GitCommitHorizontal`        | `GitCommitHorizontalIcon`        |      11 |
| `Laptop`                     | `LaptopIcon`                     |      11 |
| `LogIn`                      | `Login01Icon`                    |      11 |
| `Zap`                        | `FlashIcon`                      |      11 |
| `ChevronUp`                  | `ArrowUp01Icon`                  |      10 |
| `FileDiff`                   | `FileDiffIcon`                   |      10 |
| `FolderKanban`               | `FolderKanbanIcon`               |      10 |
| `Keyboard`                   | `KeyboardIcon`                   |      10 |
| `List`                       | `ListIcon`                       |      10 |
| `ListChevronsDownUp`         | `ListChevronsDownUpIcon`         |      10 |
| `MessagesSquare`             | `MessageMultiple01Icon`          |      10 |
| `Archive`                    | `ArchiveIcon`                    |       9 |
| `Brain`                      | `BrainIcon`                      |       9 |
| `Chrome`                     | `InternetIcon`                   |       9 |
| `Code2`                      | `CodeIcon`                       |       9 |
| `Database`                   | `DatabaseIcon`                   |       9 |
| `History`                    | `WorkHistoryIcon`                |       9 |
| `ScanSearch`                 | `SearchAreaIcon`                 |       9 |
| `CheckCircle`                | `CheckmarkCircle01Icon`          |       8 |
| `Ellipsis`                   | `EllipsisIcon`                   |       8 |
| `File`                       | `File01Icon`                     |       8 |
| `Filter`                     | `FilterIcon`                     |       8 |
| `GitFork`                    | `GitForkIcon`                    |       8 |
| `GitPullRequestDraft`        | `GitPullRequestDraftIcon`        |       8 |
| `Grip`                       | `GripIcon`                       |       8 |
| `Infinity`                   | `Infinity01Icon`                 |       8 |
| `Link2`                      | `Link02Icon`                     |       8 |
| `Monitor`                    | `MonitorIcon`                    |       8 |
| `Rocket`                     | `RocketIcon`                     |       8 |
| `Square`                     | `SquareIcon`                     |       8 |
| `Undo2`                      | `Undo02Icon`                     |       8 |
| `Wrench`                     | `Wrench01Icon`                   |       8 |
| `AtSign`                     | `AtIcon`                         |       7 |
| `Braces`                     | `FirstBracketIcon`               |       7 |
| `Chromium`                   | `InternetIcon`                   |       7 |
| `CircleSlash`                | `CircleSlashIcon`                |       7 |
| `Diff`                       | `DiffIcon`                       |       7 |
| `Flag`                       | `Flag01Icon`                     |       7 |
| `Gauge`                      | `DashboardSquare01Icon`          |       7 |
| `GitPullRequestClosed`       | `GitPullRequestClosedIcon`       |       7 |
| `InfinityIcon`               | `Infinity01Icon`                 |       7 |
| `KeyRound`                   | `Key02Icon`                      |       7 |
| `LayoutList`                 | `LayoutListIcon`                 |       7 |
| `ListChevronsUpDown`         | `ListChevronsDownUpIcon`         |       7 |
| `Minimize2`                  | `ArrowShrink01Icon`              |       7 |
| `MousePointer2`              | `Cursor02Icon`                   |       7 |
| `Pin`                        | `PinIcon`                        |       7 |
| `PlayCircle`                 | `PlayCircleIcon`                 |       7 |
| `ArrowLeftRight`             | `ArrowLeftRightIcon`             |       6 |
| `CalendarClock`              | `TimeScheduleIcon`               |       6 |
| `ChevronsRight`              | `ArrowRightDoubleIcon`           |       6 |
| `ClipboardList`              | `ClipboardListIcon`              |       6 |
| `FolderPlus`                 | `FolderAddIcon`                  |       6 |
| `FolderTree`                 | `FolderTreeIcon`                 |       6 |
| `LayoutGrid`                 | `DashboardSquare01Icon`          |       6 |
| `ListTree`                   | `HierarchyFilesIcon`             |       6 |
| `Pause`                      | `PauseIcon`                      |       6 |
| `SquarePen`                  | `PencilEdit02Icon`               |       6 |
| `Tag`                        | `Tag01Icon`                      |       6 |
| `Activity`                   | `Activity01Icon`                 |       5 |
| `CircleHelp`                 | `HelpCircleIcon`                 |       5 |
| `Clipboard`                  | `ClipboardIcon`                  |       5 |
| `CloudUpload`                | `CloudUploadIcon`                |       5 |
| `Columns3`                   | `LayoutThreeColumnIcon`          |       5 |
| `Compass`                    | `CompassIcon`                    |       5 |
| `FileCode`                   | `FileScriptIcon`                 |       5 |
| `FileSymlink`                | `FileSymlinkIcon`                |       5 |
| `FilterIcon`                 | `FilterIcon`                     |       5 |
| `FolderSearch`               | `FolderSearchIcon`               |       5 |
| `ImageIcon`                  | `Image01Icon`                    |       5 |
| `Key`                        | `Key01Icon`                      |       5 |
| `Mail`                       | `Mail01Icon`                     |       5 |
| `Palette`                    | `ColorPickerIcon`                |       5 |
| `PanelLeft`                  | `PanelLeftIcon`                  |       5 |
| `Repeat`                     | `RepeatIcon`                     |       5 |
| `Save`                       | `FloppyDiskIcon`                 |       5 |
| `Server`                     | `ServerStack01Icon`              |       5 |
| `Settings2`                  | `Settings02Icon`                 |       5 |
| `Shield`                     | `Shield01Icon`                   |       5 |
| `Split`                      | `SplitIcon`                      |       5 |
| `SquareTerminal`             | `SquareTerminalIcon`             |       5 |
| `UserRound`                  | `UserCircleIcon`                 |       5 |
| `ArchiveRestore`             | `ArchiveArrowUpIcon`             |       4 |
| `ArrowRightLeft`             | `ArrowLeftRightIcon`             |       4 |
| `ArrowUpFromLine`            | `ArrowUpFromLineIcon`            |       4 |
| `ArrowUpRight`               | `SquareArrowUpRightIcon`         |       4 |
| `BellOff`                    | `NotificationOff01Icon`          |       4 |
| `Boxes`                      | `BoxesIcon`                      |       4 |
| `BrushCleaning`              | `BrushCleaningIcon`              |       4 |
| `CaseSensitive`              | `CaseSensitiveIcon`              |       4 |
| `CheckCheck`                 | `TickDouble01Icon`               |       4 |
| `ChevronsLeftRightEllipsis`  | `ChevronsLeftRightEllipsisIcon`  |       4 |
| `CircleDashed`               | `CircleDashedIcon`               |       4 |
| `Command`                    | `CommandIcon`                    |       4 |
| `DraftingCompass`            | `DraftingCompassIcon`            |       4 |
| `FolderGit2`                 | `FolderGitTwoIcon`               |       4 |
| `Github`                     | `GithubIcon`                     |       4 |
| `HatGlasses`                 | `HatGlassesIcon`                 |       4 |
| `Home`                       | `Home01Icon`                     |       4 |
| `Link`                       | `Link01Icon`                     |       4 |
| `LoaderCircle`               | `LoaderCircleIcon`               |       4 |
| `Moon`                       | `MoonIcon`                       |       4 |
| `MousePointerClick`          | `CursorPointer02Icon`            |       4 |
| `PanelRight`                 | `PanelRightIcon`                 |       4 |
| `PenTool`                    | `PenTool01Icon`                  |       4 |
| `PinOff`                     | `PinOffIcon`                     |       4 |
| `ShieldCheck`                | `SecurityCheckIcon`              |       4 |
| `Tags`                       | `TagsIcon`                       |       4 |
| `TerminalSquare`             | `SquareTerminalIcon`             |       4 |
| `TriangleAlert`              | `TriangleAlertIcon`              |       4 |
| `Airplay`                    | `ScreenRotationIcon`             |       3 |
| `AppWindow`                  | `AppWindowIcon`                  |       3 |
| `ArrowDownToLine`            | `ArrowDownToLineIcon`            |       3 |
| `BellRing`                   | `NotificationBubbleIcon`         |       3 |
| `Briefcase`                  | `Briefcase01Icon`                |       3 |
| `Building2`                  | `Building02Icon`                 |       3 |
| `ClipboardCopy`              | `ClipboardCopyIcon`              |       3 |
| `CornerDownRight`            | `CornerDownRightIcon`            |       3 |
| `Cpu`                        | `CpuIcon`                        |       3 |
| `EyeOff`                     | `ViewOffIcon`                    |       3 |
| `Fingerprint`                | `FingerPrintIcon`                |       3 |
| `FolderOutput`               | `FolderOutputIcon`               |       3 |
| `GitCommit`                  | `GitCommitIcon`                  |       3 |
| `HelpCircle`                 | `HelpCircleIcon`                 |       3 |
| `Image`                      | `Image01Icon`                    |       3 |
| `Import`                     | `ImportIcon`                     |       3 |
| `Link2Off`                   | `Unlink02Icon`                   |       3 |
| `Package`                    | `PackageIcon`                    |       3 |
| `Power`                      | `PowerServiceIcon`               |       3 |
| `SearchIcon`                 | `Search01Icon`                   |       3 |
| `Send`                       | `MailSend01Icon`                 |       3 |
| `Share2`                     | `Share02Icon`                    |       3 |
| `ShieldOff`                  | `Shield02Icon`                   |       3 |
| `Timer`                      | `Timer01Icon`                    |       3 |
| `Toolbox`                    | `ToolboxIcon`                    |       3 |
| `Unplug`                     | `UnplugIcon`                     |       3 |
| `UserPlus`                   | `UserAdd01Icon`                  |       3 |
| `ZoomIn`                     | `ZoomInAreaIcon`                 |       3 |
| `ZoomOut`                    | `ZoomOutAreaIcon`                |       3 |
| `ArrowBigUp`                 | `ArrowUpBigIcon`                 |       2 |
| `ArrowDownFromLine`          | `ArrowDownFromLineIcon`          |       2 |
| `ArrowUpDown`                | `ArrowUpDownIcon`                |       2 |
| `BadgeCent`                  | `BadgeCentIcon`                  |       2 |
| `Bell`                       | `Notification01Icon`             |       2 |
| `Blocks`                     | `BlocksIcon`                     |       2 |
| `Book`                       | `Book01Icon`                     |       2 |
| `BookDashed`                 | `Book02Icon`                     |       2 |
| `Bug`                        | `Bug01Icon`                      |       2 |
| `CalendarArrowUp`            | `CalendarArrowUpIcon`            |       2 |
| `CalendarDays`               | `Calendar02Icon`                 |       2 |
| `ChevronsLeft`               | `ArrowLeftDoubleIcon`            |       2 |
| `ClipboardCheck`             | `ClipboardCheckIcon`             |       2 |
| `ClockArrowDown`             | `ClockArrowDownIcon`             |       2 |
| `ClockArrowUp`               | `ClockArrowUpIcon`               |       2 |
| `CloudAlert`                 | `CloudAlertIcon`                 |       2 |
| `CloudOff`                   | `CloudLoadingIcon`               |       2 |
| `Coffee`                     | `Coffee01Icon`                   |       2 |
| `Cog`                        | `CogIcon`                        |       2 |
| `Contrast`                   | `ContrastIcon`                   |       2 |
| `CornerDownLeft`             | `CornerDownLeftIcon`             |       2 |
| `Delete`                     | `Delete01Icon`                   |       2 |
| `Diamond`                    | `DiamondIcon`                    |       2 |
| `Dock`                       | `DockIcon`                       |       2 |
| `Expand`                     | `ExpandIcon`                     |       2 |
| `FileEdit`                   | `Edit04Icon`                     |       2 |
| `FilePenLine`                | `Edit04Icon`                     |       2 |
| `FilePlus`                   | `FilePlusIcon`                   |       2 |
| `FileSearch`                 | `FileSearchIcon`                 |       2 |
| `FlaskConical`               | `TestTubeIcon`                   |       2 |
| `Focus`                      | `CenterFocusIcon`                |       2 |
| `FoldVertical`               | `FoldVerticalIcon`               |       2 |
| `FolderCog`                  | `FolderCogIcon`                  |       2 |
| `FolderInput`                | `FolderInputIcon`                |       2 |
| `FunctionSquare`             | `FunctionSquareIcon`             |       2 |
| `Funnel`                     | `FunnelIcon`                     |       2 |
| `GitBranchMinus`             | `GitBranchMinusIcon`             |       2 |
| `GitBranchPlus`              | `GitBranchIcon`                  |       2 |
| `GitCommitVertical`          | `GitCommitVerticalIcon`          |       2 |
| `GitCompareArrows`           | `GitCompareIcon`                 |       2 |
| `GripVertical`               | `GripVerticalIcon`               |       2 |
| `ImageOff`                   | `ImageNotFound01Icon`            |       2 |
| `Lightbulb`                  | `BulbIcon`                       |       2 |
| `ListFilter`                 | `ListFilterIcon`                 |       2 |
| `ListFilter`                 | `FilterMailIcon`                 |       2 |
| `Loader`                     | `Loading01Icon`                  |       2 |
| `MapPin`                     | `Location01Icon`                 |       2 |
| `MessageCircleMore`          | `MessageCircleMoreIcon`          |       2 |
| `MessageCircleQuestionMark`  | `MessageCircleQuestionMarkIcon`  |       2 |
| `MessageSquareMore`          | `MessageSquareMoreIcon`          |       2 |
| `MessageSquarePlus`          | `MessageAdd01Icon`               |       2 |
| `MessageSquareText`          | `Message02Icon`                  |       2 |
| `MilestoneIcon`              | `RoadLocation01Icon`             |       2 |
| `MoveVertical`               | `MoveTopIcon`                    |       2 |
| `Option`                     | `OptionIcon`                     |       2 |
| `PackageCheck`               | `PackageDeliveredIcon`           |       2 |
| `PanelBottom`                | `SidebarBottomIcon`              |       2 |
| `PanelRightOpen`             | `PanelRightOpenIcon`             |       2 |
| `PencilRuler`                | `PencilRulerIcon`                |       2 |
| `Phone`                      | `SmartPhone01Icon`               |       2 |
| `Plug`                       | `Plug01Icon`                     |       2 |
| `Radar`                      | `Radar01Icon`                    |       2 |
| `Regex`                      | `RegexIcon`                      |       2 |
| `SquareArrowRight`           | `SquareArrowRight01Icon`         |       2 |
| `Star`                       | `StarIcon`                       |       2 |
| `Store`                      | `Store01Icon`                    |       2 |
| `Type`                       | `TypeIcon`                       |       2 |
| `UserRoundCog`               | `UserRoundCogIcon`               |       2 |
| `Variable`                   | `VariableIcon`                   |       2 |
| `Wallet`                     | `Wallet01Icon`                   |       2 |
| `WholeWord`                  | `WholeWordIcon`                  |       2 |
| `Wifi`                       | `Wifi01Icon`                     |       2 |
| `Workflow`                   | `WorkflowCircle01Icon`           |       2 |
| `AlignHorizontalSpaceAround` | `AlignHorizontalSpaceAroundIcon` |       1 |
| `AlignLeft`                  | `TextAlignLeftIcon`              |       1 |
| `AlignVerticalSpaceAround`   | `AlignVerticalSpaceAroundIcon`   |       1 |
| `Anchor`                     | `AnchorIcon`                     |       1 |
| `ArrowBigLeft`               | `ArrowLeftBigIcon`               |       1 |
| `ArrowBigRight`              | `ArrowRightBigIcon`              |       1 |
| `ArrowBigRightDash`          | `ArrowBigRightDashIcon`          |       1 |
| `ArrowDown10`                | `ArrangeByNumbersOneNineIcon`    |       1 |
| `ArrowDownAZ`                | `ArrangeByLettersZAIcon`         |       1 |
| `ArrowDownToDot`             | `ArrowDownToDotIcon`             |       1 |
| `ArrowUpFromDot`             | `ArrowUpFromDotIcon`             |       1 |
| `ArrowUpRightFromSquare`     | `SquareArrowUpRightIcon`         |       1 |
| `Award`                      | `Award01Icon`                    |       1 |
| `Ban`                        | `BanIcon`                        |       1 |
| `BarChart`                   | `BarChartIcon`                   |       1 |
| `BarChart3`                  | `BarChartIcon`                   |       1 |
| `Blend`                      | `BlendIcon`                      |       1 |
| `Bold`                       | `TextBoldIcon`                   |       1 |
| `BookMarked`                 | `BookBookmark01Icon`             |       1 |
| `BookSearch`                 | `BookSearchIcon`                 |       1 |
| `BotMessageSquare`           | `ChatBotIcon`                    |       1 |
| `BotOff`                     | `BotOffIcon`                     |       1 |
| `BriefcaseBusiness`          | `Briefcase02Icon`                |       1 |
| `Cable`                      | `UsbIcon`                        |       1 |
| `CalendarOff`                | `CalendarBlock01Icon`            |       1 |
| `CalendarX`                  | `CalendarRemove01Icon`           |       1 |
| `Camera`                     | `Camera01Icon`                   |       1 |
| `Captions`                   | `CaptionsIcon`                   |       1 |
| `ChartColumn`                | `ChartColumnIcon`                |       1 |
| `ChartGantt`                 | `ChartGanttIcon`                 |       1 |
| `ChartNoAxesGantt`           | `ChartNoAxesGanttIcon`           |       1 |
| `CheckSquare`                | `CheckmarkSquare01Icon`          |       1 |
| `CircleArrowOutUpRight`      | `CircleArrowOutUpRightIcon`      |       1 |
| `CircleArrowUp`              | `CircleArrowUp01Icon`            |       1 |
| `CircleCheck`                | `CircleCheckIcon`                |       1 |
| `CircleDollarSign`           | `CircleDollarSignIcon`           |       1 |
| `CircleDotDashed`            | `CircleDotDashedIcon`            |       1 |
| `CircleMinus`                | `MinusSignCircleIcon`            |       1 |
| `CirclePile`                 | `CirclePileIcon`                 |       1 |
| `CircleSlash2`               | `CircleSlashTwoIcon`             |       1 |
| `CircleX`                    | `CircleXIcon`                    |       1 |
| `ClipboardPen`               | `ClipboardPenIcon`               |       1 |
| `Clock3`                     | `Clock03Icon`                    |       1 |
| `CloudDownload`              | `CloudDownloadIcon`              |       1 |
| `Coins`                      | `Coins01Icon`                    |       1 |
| `Computer`                   | `ComputerIcon`                   |       1 |
| `ComputerUse`                | `CursorMagicSelection04Icon`     |       1 |
| `CopyCheck`                  | `Copy02Icon`                     |       1 |
| `CopyPlus`                   | `CopyPlusIcon`                   |       1 |
| `CopyX`                      | `CopyXIcon`                      |       1 |
| `CornerUpLeft`               | `CornerUpLeftIcon`               |       1 |
| `CreditCard`                 | `CreditCardIcon`                 |       1 |
| `Crosshair`                  | `CrosshairIcon`                  |       1 |
| `Eclipse`                    | `EclipseIcon`                    |       1 |
| `Edit`                       | `Edit01Icon`                     |       1 |
| `Edit2`                      | `Edit02Icon`                     |       1 |
| `ExternalLink`               | `SquareArrowUpRightIcon`         |       1 |
| `Feather`                    | `FeatherIcon`                    |       1 |
| `FileBox`                    | `FileBoxIcon`                    |       1 |
| `FileCode2`                  | `FileCodeIcon`                   |       1 |
| `FileJson`                   | `FileCodeIcon`                   |       1 |
| `FilePen`                    | `Edit04Icon`                     |       1 |
| `FilePlus2`                  | `FileAddIcon`                    |       1 |
| `Files`                      | `Files01Icon`                    |       1 |
| `Flame`                      | `FireIcon`                       |       1 |
| `FolderCode`                 | `FolderCodeIcon`                 |       1 |
| `FolderMinus`                | `FolderMinusIcon`                |       1 |
| `FolderSymlink`              | `FolderSymlinkIcon`              |       1 |
| `Fuel`                       | `FuelIcon`                       |       1 |
| `Fullscreen`                 | `FullScreenIcon`                 |       1 |
| `GalleryThumbnails`          | `GalleryThumbnailsIcon`          |       1 |
| `GanttChart`                 | `ChartGanttIcon`                 |       1 |
| `Globe2`                     | `InternetIcon`                   |       1 |
| `Hammer`                     | `LegalHammerIcon`                |       1 |
| `HandMetal`                  | `Shaka01Icon`                    |       1 |
| `Heading2`                   | `Heading02Icon`                  |       1 |
| `Headphones`                 | `HeadphonesIcon`                 |       1 |
| `Heart`                      | `FavouriteIcon`                  |       1 |
| `HeartPulse`                 | `Cardiogram01Icon`               |       1 |
| `Hexagon`                    | `HexagonIcon`                    |       1 |
| `History`                    | `BubbleChatIcon`                 |       1 |
| `IdCard`                     | `IdCardIcon`                     |       1 |
| `Italic`                     | `TextItalicIcon`                 |       1 |
| `Languages`                  | `LanguageCircleIcon`             |       1 |
| `LaptopMinimal`              | `LaptopMinimalIcon`              |       1 |
| `LayoutDashboard`            | `DashboardSquare01Icon`          |       1 |
| `LayoutPanelTop`             | `LayoutTopIcon`                  |       1 |
| `LinkIcon`                   | `Link01Icon`                     |       1 |
| `List`                       | `LeftToRightListBulletIcon`      |       1 |
| `ListOrdered`                | `LeftToRightListNumberIcon`      |       1 |
| `Logs`                       | `LogsIcon`                       |       1 |
| `MailOpen`                   | `MailOpen01Icon`                 |       1 |
| `Map`                        | `MapsIcon`                       |       1 |
| `Maximize`                   | `ArrowExpand01Icon`              |       1 |
| `Menu`                       | `Menu01Icon`                     |       1 |
| `MessageCircleQuestion`      | `MessageCircleQuestionMarkIcon`  |       1 |
| `MessageCircleWarning`       | `MessageCircleWarningIcon`       |       1 |
| `Mic`                        | `Mic01Icon`                      |       1 |
| `Milestone`                  | `RoadLocation01Icon`             |       1 |
| `MonitorCog`                 | `ComputerSettingsIcon`           |       1 |
| `MonitorDot`                 | `MonitorDotIcon`                 |       1 |
| `MonitorPlay`                | `ComputerVideoIcon`              |       1 |
| `MonitorSmartphone`          | `ComputerPhoneSyncIcon`          |       1 |
| `MoveHorizontal`             | `MoveLeftIcon`                   |       1 |
| `NewSession`                 | `MessageAdd02Icon`               |       1 |
| `Omega`                      | `OmegaIcon`                      |       1 |
| `Package2`                   | `Package01Icon`                  |       1 |
| `Paintbrush`                 | `PaintBrush01Icon`               |       1 |
| `PanelsTopLeft`              | `PanelsTopLeftIcon`              |       1 |
| `Paperclip`                  | `AttachmentIcon`                 |       1 |
| `PenLine`                    | `PenLineIcon`                    |       1 |
| `PencilLine`                 | `PencilEdit01Icon`               |       1 |
| `PictureInPicture2`          | `PictureInPicture01Icon`         |       1 |
| `Plane`                      | `Airplane01Icon`                 |       1 |
| `Puzzle`                     | `PuzzleIcon`                     |       1 |
| `Quote`                      | `QuoteIcon`                      |       1 |
| `Radio`                      | `RadioIcon`                      |       1 |
| `Replace`                    | `ReplaceIcon`                    |       1 |
| `ReplaceAll`                 | `ReplaceAllIcon`                 |       1 |
| `Reply`                      | `MailReply01Icon`                |       1 |
| `Rewind`                     | `RewindIcon`                     |       1 |
| `RotateCw`                   | `RotateClockwiseIcon`            |       1 |
| `Rows2`                      | `LayoutTwoRowIcon`               |       1 |
| `RulerDimensionLine`         | `RulerDimensionLineIcon`         |       1 |
| `ScrollText`                 | `ScrollIcon`                     |       1 |
| `SearchCode`                 | `Search02Icon`                   |       1 |
| `SearchX`                    | `SearchMinusIcon`                |       1 |
| `SettingsIcon`               | `Settings01Icon`                 |       1 |
| `Sheet`                      | `SheetIcon`                      |       1 |
| `ShieldAlert`                | `ShieldAlertIcon`                |       1 |
| `ShieldBan`                  | `SecurityBlockIcon`              |       1 |
| `SignalHigh`                 | `SignalFull01Icon`               |       1 |
| `SkipBack`                   | `SkipBackIcon`                   |       1 |
| `SkipForward`                | `Forward01Icon`                  |       1 |
| `Slash`                      | `SlashIcon`                      |       1 |
| `SlidersHorizontal`          | `SlidersHorizontalIcon`          |       1 |
| `Space`                      | `SaturnIcon`                     |       1 |
| `Sparkle`                    | `SparkleIcon`                    |       1 |
| `Sprout`                     | `Plant01Icon`                    |       1 |
| `SquareChevronRight`         | `SquareChevronRightIcon`         |       1 |
| `SquareKanban`               | `KanbanIcon`                     |       1 |
| `SquareMousePointer`         | `SquareMousePointerIcon`         |       1 |
| `SquareRoundCorner`          | `SquareRoundCornerIcon`          |       1 |
| `SquareStack`                | `SquareStackIcon`                |       1 |
| `StopCircle`                 | `StopCircleIcon`                 |       1 |
| `Strikethrough`              | `TextStrikethroughIcon`          |       1 |
| `Sun`                        | `Sun01Icon`                      |       1 |
| `TableProperties`            | `TablePropertiesIcon`            |       1 |
| `TagIcon`                    | `Tag01Icon`                      |       1 |
| `Target`                     | `Target01Icon`                   |       1 |
| `TextQuote`                  | `TextQuoteIcon`                  |       1 |
| `ThumbsUp`                   | `ThumbsUpIcon`                   |       1 |
| `Ticket`                     | `Ticket01Icon`                   |       1 |
| `TrendingDown`               | `AnalyticsDownIcon`              |       1 |
| `TrendingUp`                 | `AnalyticsUpIcon`                |       1 |
| `Unlink2`                    | `Unlink02Icon`                   |       1 |
| `Unlock`                     | `SquareUnlock01Icon`             |       1 |
| `UserMinus`                  | `UserMinus01Icon`                |       1 |
| `UserRoundCheck`             | `UserRoundCheckIcon`             |       1 |
| `UsersRound`                 | `UsersRoundIcon`                 |       1 |
| `Wand2`                      | `MagicWand02Icon`                |       1 |
| `Waypoints`                  | `WaypointsIcon`                  |       1 |
