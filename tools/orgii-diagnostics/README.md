# ORGII 独立诊断工具

这是一个仅供开发排障使用的外部命令行工具。它不导入 ORGII 前端代码，不注册 Tauri 命令，也不进入 App 的生产运行路径。

## 快速开始

先启动 ORGII，再检查与当前工作区或 App 进程树有关的僵尸/疑似被系统接管进程：

```bash
pnpm diag:process
```

如果同时运行了多个 ORGII 实例，请指定主进程：

```bash
pnpm diag:process --pid 12345
```

开始前台内存录制：

```bash
pnpm diag:memory record --pid auto
```

默认每 15 秒采样一次，最多 720 个样本；每个样本最多保留 256 条进程明细，但总 RSS 仍按全部归属进程计算。录制期间可在另一个终端标记操作阶段并停止：

```bash
pnpm diag:memory mark "连续打开并关闭 20 个会话"
pnpm diag:memory stop
```

也可以用 `Ctrl-C` 停止。检查状态或重新生成最近一次报告：

```bash
pnpm diag:memory status
pnpm diag:memory report
```

常用边界参数：

```bash
pnpm diag:memory record --interval 5 --duration 300 --max-samples 120
```

## 产物与口径

默认产物写入被 Git 忽略的 `.orgii/diagnostics/sessions/<会话 ID>/`：

- `session.json`：根进程身份、采样配置和停止原因。
- `samples.ndjson`：逐次原始样本，写一条落盘一条，不在内存中累积。
- `markers/`：操作阶段标记。
- `report.json`：机器可读的完整报告。
- `samples.csv`：每个进程、每次采样一行，便于画图。
- `summary.md`：趋势、峰值和阶段标记摘要。

工具使用 PID 与进程启动时间共同标识进程实例。根 PID 退出或被复用时，录制会停止，不会把新进程的数据接到旧会话。

当前 macOS/Linux 采样指标是系统 `ps` 提供的 RSS、虚拟内存和 CPU。macOS WebKit 辅助进程通过 `launchctl print pid/<宿主 PID>` 做宿主范围归因，并再次核对用户、系统 WebKit 路径和角色。报告中的 RSS 总和适合看趋势，但共享页可能被重复计算，不能单独证明内存泄漏。

写入报告的命令行会截断到 300 个字符，并遮盖常见的 token、密码、API key 和 URL 凭据参数。诊断产物仍可能包含本机路径及业务进程名称，请在对外分享前复核。

## 状态与失败行为

录制生命周期为 `idle → recording → ready`。停止、达到时长/样本上限、根进程退出和连续三次采样失败都会进入收尾并生成报告。

若记录器被强制终止，活动状态会标为旧会话；下一次 `record` 会按记录器 PID 与启动时间确认它确实已退出，再取得新的录制所有权。`mark` 和 `stop` 遇到旧状态会拒绝操作。外部 `stop` 只写入当前会话的停止请求文件，不向记录器 PID 发信号，因而没有 PID 复用误杀窗口。

工具不会自动结束它发现的进程。`diag:process` 给出的是收窄后的审计结果；确认无用后再使用对应进程自己的退出方式处理。
