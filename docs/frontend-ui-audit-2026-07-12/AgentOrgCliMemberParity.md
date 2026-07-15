# Agent Org CLI Member UI Boundary Audit

> 日期：2026-07-12
> 范围：本次修改的 Agent Org 设置、成员选择器和对应 rendered E2E。
> 方法说明：仓库 `AGENTS.md` 指向的 `~/.orgii/skills/frontend-ui-audit/SKILL.md` 在当前环境不存在；以下按仓库规定的逐元素表格格式进行人工替代审计。

## Verdict summary

| Verdict           | Count |
| ----------------- | ----: |
| fix（本次已完成） |     4 |
| keep with reason  |     5 |
| abstract later    |     1 |
| open finding      |     0 |

## Audit table

| Line                                    | Element                               | Verdict          | Reason                                                                                                                   | Suggested change                                                                  |
| --------------------------------------- | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `SessionCreatorOrgMembersPanel.tsx:403` | Agent Org member picker               | fix（已完成）    | Session Creator 原先复用通用 picker，会展示当前后端无法运行的 CLI member。                                               | 传入 `hideCliAgents`，保留 Rust built-in/custom 和现有视觉结构。                  |
| `AgentTeamWizard.tsx:88`                | Agent Org 新建/编辑 wizard options    | fix（已完成）    | 设置页此前显式拉取并注入 installed CLI agents，界面能力声明高于 runtime。                                                | 只使用 Rust-native built-in/custom definitions。                                  |
| `OrgDetailView.tsx:101`                 | 旧 Org 详情编辑 options               | fix（已完成）    | 详情页也必须与 wizard 使用相同的 capability boundary。                                                                   | 使用相同的 Rust-only `buildAgentOptions`。                                        |
| `AgentOrgs/index.tsx:124`               | CLI agent fetching state/effect       | fix（已完成）    | 数据仅服务于已禁用的 Agent Org CLI picker，继续请求会造成死状态和误导。                                                  | 删除 `cliAgents` state、fetch/refresh effect 和 prop plumbing。                   |
| `DispatchCategoryPalette/index.tsx:99`  | `hideCliAgents` prop                  | keep with reason | 共享 picker 在普通会话中仍要显示 CLI；不能全局删除 CLI category。显式 capability flag 能把限制控制在 Agent Org surface。 | 保持默认 `false`，只在 Agent Org member picker 传 `true`。                        |
| `DispatchCategoryDropdown.tsx:125`      | dropdown parity                       | keep with reason | Dropdown 和 modal palette 是两个现有渲染入口；只改一个会产生响应式/入口差异。                                            | 保持 prop 透传和默认值一致。                                                      |
| `useDispatchCategoryOptions.tsx:340`    | option filtering                      | keep with reason | hook 版本仍被其他 picker 使用，需要与 component 版本一致过滤 CLI option/header。                                         | 保持 `hideCliAgents` 同时影响 options 和 group header。                           |
| `config.ts:22`                          | `buildAgentOptions` Rust-only builder | keep with reason | 这是 Agent Org 专用 builder，不是全局 Agent picker；在这里收窄不会影响普通 CLI session。                                 | 注释继续明确 Rust-native 范围。                                                   |
| `agentOrgUiDriver.mjs:988`              | rendered negative assertion           | keep with reason | 仅检查保存失败不足以证明 UI 没撒谎；生产 picker 必须在 DOM 层不出现 `cli-*` option。                                     | 在可用桌面 E2E 环境运行对应 rendered spec。                                       |
| Palette component + hook                | duplicated option composition         | abstract later   | 两套相近组合逻辑是既有结构，本次必须双改才能保证入口一致；继续扩展 flags 会增加漂移风险。                                | 独立 PR 抽出纯 `buildDispatchCategoryGroups` selector，并让 modal/dropdown 共用。 |

## UI behavior conclusion

- Agent Org 新建、编辑和 Session Creator member override 不再展示 CLI agents。
- 普通 CLI session 和 CLI-only picker 不受影响，因为 `hideCliAgents` 默认关闭。
- 旧 CLI Agent Org 仍可加载并删除；保存或启动时由后端给出明确 unsupported validation。
- 没有新增 arbitrary Tailwind value、视觉 token、交互控件或 a11y pattern；本次 UI diff 是能力过滤和无用数据流删除。
- TypeScript、目标 ESLint 和修改 `.mjs` 的语法检查通过；完整 rendered desktop E2E 待具备运行环境后执行。
