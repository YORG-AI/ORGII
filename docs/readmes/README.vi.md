<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Agent IDE open-source theo phong cách Cursor — nhưng được xây dựng cho khả năng review, truy vết và tự do sáng tạo, không chỉ để code nhanh hơn.</strong></p>
  <p>Được xây dựng bằng Rust và Tauri cho thực thi local-first, chiếm dưới 100MB trên ổ đĩa. Hỗ trợ livestream và replay trajectory của Agents. Dễ theo dõi và review.</p>
  <p>
    <a href="../../LICENSE"><img alt="License" src="https://img.shields.io/github/license/yorgai/ORG2?style=flat-square" /></a>
    <a href="https://github.com/yorgai/ORG2/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/yorgai/ORG2/total?style=flat-square&label=downloads" /></a>
    <a href="https://github.com/yorgai/ORG2/commits/develop"><img alt="Last commit" src="https://img.shields.io/github/last-commit/yorgai/ORG2?style=flat-square&label=last%20commit" /></a>
    <a href="https://github.com/yorgai/ORG2/graphs/commit-activity"><img alt="Commit activity" src="https://img.shields.io/github/commit-activity/m/yorgai/ORG2?style=flat-square&label=commit%20activity" /></a>
  </p>
</div>

---

<p align="center">
  <a href="https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg"><strong>macOS Apple Silicon</strong></a>
  ·
  <a href="https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe"><strong>Windows installer</strong></a>
  ·
  <a href="https://github.com/yorgai/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi"><strong>Windows MSI</strong></a>
  ·
  <a href="https://github.com/yorgai/ORG2/releases/latest"><strong>All latest release assets</strong></a>
</p>

---

<p align="center">
  <a href="../../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.zh.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.ru.md">Русский</a> · <a href="README.pt.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/bd4833d2-4cc4-4971-9805-84529b14d01a" controls width="720"></video>
</p>

Đây không chỉ là một công cụ lập trình AI khác; đây là một thử nghiệm về tổ chức human/Agent và org-level alignment. Agents đang tốt hơn, nhưng collaboration, observability, cấu trúc và accountability chung không theo kịp — và trong một số trường hợp còn tệ hơn. Cursor, Claude Code và các công cụ tương tự thường xem Agents như trợ lý thuê ngoài: hữu ích cho đầu ra, nhưng khó audit, phối hợp, align hoặc tiến hóa ở cấp hệ thống.

ORG-II khám phá một mô hình khác: Agents như những đồng nghiệp bền bỉ và có thể quan sát trong một tổ chức có cấu trúc. Thay vì các AI IDE sessions không trạng thái và khó review, nó giới thiệu Agent execution có thể replay, bộ nhớ xuyên phiên, AI blame và local-first Rust runtime để con người, Agents và nhóm có thể cộng tác quanh ngữ cảnh chung và mục tiêu đã align.

## Khả năng chính

- Sessions chạy lâu với execution traces có thể replay để audit, review và debug.
- Agents dựa trên Rust hoạt động với API keys và đăng ký Agents hiện có của bạn.
- GUI, CLI, Terminal, Git, trình duyệt, LSP, timeline và công cụ cơ sở dữ liệu.
- Bộ nhớ xuyên phiên, chia sẻ tri thức giữa Agents và trạng thái Workspace chung.
- Thực thi nhận biết tài nguyên, có thể phản ứng với CPU, RAM và mức độ sẵn sàng của sự chú ý con người.
- Kiểm thử GUI end-to-end do Agent hỗ trợ cho tự tiến hóa có giám sát.
- Scheduling và auto-started sessions để Agents có thể chạy qua đêm hoặc tiếp tục công việc khi bạn vắng mặt.
- Bề mặt org-level alignment để phối hợp con người, Agents, mục tiêu và accountability (WIP).
- Session collaboration và group issue workflows qua Supabase tự host (WIP).

## Tải xuống

Tải ORGII desktop app mới nhất từ trang [Releases](https://github.com/YORG-AI/ORGII/releases). Mở release mới nhất, tải installer hoặc app bundle cho nền tảng của bạn và làm theo hướng dẫn của hệ điều hành để cài đặt ORGII.

## Phát triển từ mã nguồn

Để build hoặc đóng góp từ mã nguồn:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Để biết thêm chi tiết đóng góp, xem [CONTRIBUTING.md](../../CONTRIBUTING.md). Chúng tôi mong mọi người tôn trọng và đồng cảm; xem [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## Native sidecars tùy chọn

Các tính năng Browser Use và Computer Use phụ thuộc vào native helpers tùy chọn cho tự động hóa trình duyệt và tự động hóa màn hình macOS:

- `agent-browser` được tải từ releases của `vercel-labs/agent-browser` cho OS/CPU hiện tại.
- `peekaboo` được tải từ releases của `steipete/peekaboo` trên macOS.

Computer Use hiện chỉ khả dụng trên macOS. Browser Use có thể dùng `agent-browser` trên các nền tảng được hỗ trợ.

Nếu thiếu sidecar, Rust build tạo một placeholder resource nhỏ để các development builds có thể tiếp tục. Khả năng liên quan có thể fallback về `PATH` hoặc vẫn không khả dụng cho đến khi bạn chạy `pnpm run download:sidecars`.

## Giấy phép

ORGII được cấp phép theo GNU Affero General Public License v3.0 hoặc mới hơn (`AGPL-3.0-or-later`). Xem [`LICENSE`](../../LICENSE) để biết toàn văn giấy phép.
