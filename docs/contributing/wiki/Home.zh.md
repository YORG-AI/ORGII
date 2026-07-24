# ORGII Wiki

🌐 [English](Home) · [Français](Home.fr) · **中文**

**ORGII** 是一个自进化的智能体开发框架 —— 一个基于 Tauri 和 Rust 构建的轻量级桌面 IDE，让您能够管理和编排 AI 智能体。

## ORGII 能做什么

- **Rust 原生智能体** — 内置的 SDE Agent 和 OS Agent 直接在 Rust 运行时中运行，比基于 Electron 的工具更轻量。
- **自进化** — 智能体和 GUI 均有端到端测试覆盖，支持有监督的自我改进。相关研究论文即将发布。
- **Agentic Orgs** — 定义智能体角色、规则、技能和 MCP 服务器，组合多智能体工作流。
- **携带您自己的密钥** — 连接 Codex、Claude Code、Deepseek、Cursor、Gemini、GitHub Copilot、Kiro、Kimi 等工具的现有密钥和订阅。

## 我们的功能

| 功能               | 状态                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话记忆 Embedding | 可在 **集成 → 规则、记忆与进化 → 记忆** 中配置；符合条件的会话更新后自动运行。支持禁用、本地 Qwen、本地 CodeRank 与 Key Vault 支持的 Embedding API。 |

## 快速导航

| 主题                  | 页面                                 |
| --------------------- | ------------------------------------ |
| 安装与初次运行        | [快速入门](Getting-Started.zh)       |
| 架构概览              | [架构概览](Architecture-Overview.zh) |
| 智能体会话            | [会话](Sessions.zh)                  |
| WorkStation（编辑器） | [WorkStation](WorkStation.zh)        |
| 密钥库与提供商        | [密钥库](Key-Vault.zh)               |
| 智能体配置            | [智能体](Agents.zh)                  |
| 贡献指南              | [贡献](Contributing.zh)              |
| 常见问题              | [FAQ](FAQ.zh)                        |
| 更新日志              | [Changelog](Changelog.zh)            |

## 下载

从 [Releases](https://github.com/YORG-AI/ORGII/releases) 页面下载最新桌面版本。

## 许可证

ORGII 采用 [AGPL-3.0-or-later](https://github.com/YORG-AI/ORGII/blob/main/LICENSE) 许可证。
