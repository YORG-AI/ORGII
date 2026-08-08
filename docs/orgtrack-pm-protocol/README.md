# Orgtrack PM Protocol — Phase 0 frozen artifacts

`orgtrack/v1` WorkItem + Routine CLI 协议的 Phase 0 产出。本目录是协议 wire
contract 的 source of truth：schemas 与 golden fixtures 会被后续 Phase 3+ 的
conformance 测试直接消费；`decisions.md` 记录 Phase 0 冻结的全部命名与边界
决策，实现与之冲突时以本目录为准。

设计依据是《Orgtrack WorkItem + Routine CLI Protocol — 最终设计》rev 2
（2026-08-04 审计修订版，暂未入库）。

## 目录

```text
decisions.md          Phase 0 冻结决策（mode/capability/provider id/hook 名/
                      manifest/CLI 载体/watermark/exit code）
parity-matrix.md      入口一致性矩阵（每个 phase 落地时填格）
schemas/              JSON Schema（draft-07）
  common.schema.json            共享 $defs：ActorRef、SessionRef、状态枚举、
                                capability 词汇表
  envelope.schema.json          success/error CLI envelopes 与稳定错误码
  execution-context.schema.json `org2 context` 返回的 ExecutionContext
  work-item.schema.json         WorkItem canonical shape
  routine.schema.json           portable Routine spec
  routine-run.schema.json       RoutineRun occurrence
fixtures/
  success/            每个 command family 的 success envelope golden fixture
  errors/             18 个稳定错误码各一份 golden fixture
```

## 约定

- fixtures 是 byte-level golden：conformance 测试比较真实 serialized bytes，
  不允许隐藏 `$schema`、remote `$ref`、secret 或本地路径混入 wire payload；
- 未列入 `envelope.schema.json` 错误码枚举的 code 不得出现在任何实现中；
- schemas 修改需要同步更新 fixtures 与 `decisions.md`，三者不一致视为 CI 失败
  （Phase 3 接入）。

## Phase 0 未尽项

- 现有 Routine/WorkItem 数据导出（migration fixture）需要开发机的
  `projects.db`，推迟到 Phase 4 开工时以脚本完成，脚本与导出样本届时入库。
