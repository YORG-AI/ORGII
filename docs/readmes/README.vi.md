<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Hệ thống ghi nhận cách Agents xây dựng phần mềm.<br />Chạy các Agent lập trình của bạn — replay bất kỳ phiên nào, review theo nhóm và truy vết từng dòng về đúng quyết định đằng sau nó.</strong></p>
  <p>Được xây dựng bằng Rust và Tauri cho thực thi local-first, chiếm dưới 100MB trên ổ đĩa. Hỗ trợ livestream và replay trajectory của Agents. Dễ theo dõi và review.</p>
</div>

---

<p align="center">
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg"><strong>macOS Apple Silicon</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe"><strong>Windows installer</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi"><strong>Windows MSI</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage"><strong>Linux AppImage</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb"><strong>Linux DEB</strong></a>
  ·
  <a href="https://github.com/org2AI/ORG2/releases/latest"><strong>All latest release assets</strong></a>
</p>

---

<p align="center">
  <a href="../../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.zh.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.ru.md">Русский</a> · <a href="README.pt.md">Português</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <video src="https://github.com/user-attachments/assets/bd4833d2-4cc4-4971-9805-84529b14d01a" controls width="720"></video>
</p>

Để trả lời vì sao một đoạn mã tồn tại — và liệu nó có hiệu quả hay không — người ta luôn phải ghép thủ công nhiều hệ thống lại với nhau. Jira chỉ thấy ticket. Codex chỉ thấy phiên của chính nó. GitHub chỉ thấy những dòng đã commit. Amplitude chỉ thấy chỉ số. Điều đó còn chịu được khi con người viết mã. Ở tốc độ của Agent thì không: mã viết hôm thứ Hai đến thứ Sáu đã thành legacy.

ORG-2 là nơi nhóm của bạn chạy các Agent lập trình — một Rust harness native cùng trình khởi chạy cho hơn 20 Agent CLI — và nó tự động dựng nên bản ghi đó. Mỗi phiên trở thành một trajectory mà đồng đội replay như xem video: họ review công việc thực sự đã được dựng ra sao thay vì chỉ nhìn diff, và bình luận ngay trong ngữ cảnh. Các phiên chạy ở công cụ khác cũng được nạp vào và bổ sung ngược từ lịch sử của chúng, nên bản ghi bao phủ cả phần việc chưa từng đi qua ứng dụng. Bản ghi liên kết điều con người yêu cầu, điều Agent hiểu và điều nó thực sự làm, nên bất kỳ dòng nào đã lên production đều truy ngược được về phiên đã viết ra nó.

Đây không chỉ là một công cụ lập trình AI khác; đó là một thử nghiệm về các tổ chức người/Agent và sự align ở cấp tổ chức. ORG-II xem Agents như những đồng nghiệp bền bỉ và có thể quan sát trong một tổ chức có cấu trúc — thực thi có thể replay, bộ nhớ xuyên phiên, AI blame và local-first Rust runtime để con người, Agents và nhóm cùng cộng tác quanh ngữ cảnh chung và mục tiêu đã align.

## Tính năng

<table>
<tr><td width="50%" valign="middle"><h3>Rust harness tích hợp</h3><p>Chạy Agents native nhanh, tiết kiệm token và có thể tùy chỉnh bằng API key cùng gói đăng ký Agent hiện có của bạn.</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="Chạy Agents bằng Rust harness của ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Quản lý phiên từ hơn 10 ứng dụng và CLI</h3><p>Tải và quản lý phiên Agent từ mọi công cụ tại một nơi. Quét lịch sử, kiểm tra subagents và điều khiển từng nguồn mà không cần chuyển ứng dụng.</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="Quản lý nguồn phiên Agent từ ứng dụng và CLI trong ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Lập nhóm và review trajectory, không chỉ PR</h3><p>Thành lập nhóm và chia sẻ phiên giữa các thiết bị và đồng đội. Review toàn bộ trajectory của Agent, không chỉ diff cuối cùng, và để lại bình luận đúng ngữ cảnh.</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="Quản lý đồng đội và quyền replay trajectory trong ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Tool call, giờ ở dạng video</h3><p>Replay công việc từ Rust harness native và hơn 15 CLI Agents. Tin nhắn, tool call, chỉnh sửa tệp và đầu ra lệnh luôn đồng bộ trong một timeline có thể review.</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="Replay phiên Agent trong ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>AI blame, không chỉ Git blame</h3><p>Đừng dừng ở người đã thay đổi một dòng. Truy ngược đến phiên Agent, tool call và quyết định đã tạo ra thay đổi đó.</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="Truy ngược thay đổi mã đến phiên và quyết định của Agent trong ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Luôn đi đúng hướng</h3><p>Xem thời gian của bạn được sử dụng ra sao giữa các tác vụ và phiên Agent. Timeline hoạt động hằng ngày giúp hiển thị thời lượng, thay đổi mã và mức độ ưu tiên.</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="Review thời gian dành cho tác vụ và phiên Agent trong ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Workspace phát triển đầy đủ</h3><p>Dùng terminal, quản lý source control, theo dõi lịch sử Git và review pull request mà không rời workspace Agent.</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="Source control, lịch sử Git và công cụ code review trong ORG-II" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Chế độ Design</h3><p>Kiểm tra trang trực tiếp trong trình duyệt WebKit native. Chọn một phần tử và gửi ngữ cảnh trang chính xác thẳng đến Agent để sửa một cách đơn giản.</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="Kiểm tra phần tử trang web bằng Chế độ Design của ORG-II" width="100%" /></td></tr>
</table>

## Nhiều khả năng hơn

- GUI, CLI, Terminal, Git, trình duyệt, LSP, timeline và công cụ cơ sở dữ liệu.
- Bộ nhớ xuyên phiên, chia sẻ tri thức giữa Agents và trạng thái Workspace chung.
- Thực thi nhận biết tài nguyên, có thể phản ứng với CPU, RAM và mức độ sẵn sàng của sự chú ý con người.
- Kiểm thử GUI end-to-end do Agent hỗ trợ cho tự tiến hóa có giám sát.
- Scheduling và auto-started sessions để Agents có thể chạy qua đêm hoặc tiếp tục công việc khi bạn vắng mặt.
- Bề mặt org-level alignment để phối hợp con người, Agents, mục tiêu và accountability (WIP).
- Session collaboration và group issue workflows qua Supabase tự host (WIP).

## Agents được hỗ trợ

Sử dụng Rust harness tích hợp của ORG-II hoặc khởi chạy các CLI coding-agent được hỗ trợ từ ứng dụng desktop.

### GUI + TUI

<p>
  <a href="#tính-năng"><kbd><img src="../assets/org2-icon.svg" alt="Logo ORG-2" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
  <a href="https://cursor.com/docs/cli/overview"><kbd><img src="../../src/assets/modelIcons/cursor.svg" alt="Cursor CLI logo" width="16" valign="middle" /> Cursor CLI</kbd></a> &nbsp;
  <a href="https://code.claude.com/docs/en/configuration"><kbd><img src="../../src/assets/modelIcons/claude.svg" alt="Claude logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://developers.openai.com/codex/config-basic"><kbd><img src="../../src/assets/modelIcons/openai.svg" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/installation"><kbd><img src="../../src/assets/modelIcons/kiro.svg" alt="Kiro CLI logo" width="16" valign="middle" /> Kiro CLI</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-in-the-cli"><kbd><img src="../../src/assets/modelIcons/copilot.svg" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/config/"><kbd><img src="../../src/assets/modelIcons/opencode.svg" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli/getting-started"><kbd><img src="../../src/assets/modelIcons/antigravity.svg" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a>
</p>

### TUI

<p>
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/configuration-files.html"><kbd><img src="../../src/assets/modelIcons/kimi.svg" alt="Kimi Code CLI logo" width="16" valign="middle" /> Kimi Code CLI</kbd></a> &nbsp;
  <a href="https://aider.chat/docs/config.html"><kbd><img src="../../src/assets/modelIcons/aider.svg" alt="Aider logo" width="16" valign="middle" /> Aider</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/category/getting-started/"><kbd><img src="../../src/assets/modelIcons/goose.svg" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual"><kbd><img src="../../src/assets/modelIcons/amp.svg" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cli/cli-reference"><kbd><img src="../../src/assets/modelIcons/cline.svg" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="../../src/assets/modelIcons/kilo.svg" alt="Kilo Code logo" width="16" valign="middle" /> Kilo Code</kbd></a> &nbsp;
  <a href="https://docs.x.ai/build/overview"><kbd><img src="../../src/assets/modelIcons/grok.svg" alt="Grok CLI logo" width="16" valign="middle" /> Grok CLI</kbd></a> &nbsp;
  <a href="https://docs.devin.ai/cli"><kbd><img src="../../src/assets/modelIcons/devin.svg" alt="Devin logo" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/user-guide/configuration"><kbd><img src="../../src/assets/modelIcons/hermes.svg" alt="Hermes logo" width="16" valign="middle" /> Hermes</kbd></a> &nbsp;
  <a href="https://docs.openclaw.ai/cli/config"><kbd><img src="../../src/assets/modelIcons/openclaw.svg" alt="OpenClaw logo" width="16" valign="middle" /> OpenClaw</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs"><kbd><img src="../../src/assets/modelIcons/infinity-agent.svg" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/"><kbd><img src="../../src/assets/modelIcons/qwen.svg" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/mimocode/config-files"><kbd><img src="../../src/assets/modelIcons/xiaomimimo.svg" alt="Mimo Code logo" width="16" valign="middle" /> Mimo Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/configuration"><kbd><img src="../../src/assets/modelIcons/continue.svg" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/byok/overview"><kbd><img src="../../src/assets/modelIcons/droid.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://docs.mistral.ai/vibe/code/cli/install-setup"><kbd><img src="../../src/assets/modelIcons/mistral.svg" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://docs.autohand.ai/integrations/ai-model-providers"><kbd><img src="../../src/assets/modelIcons/autohand.svg" alt="Autohand logo" width="16" valign="middle" /> Autohand</kbd></a> &nbsp;
  <a href="https://github.com/open-horizon-labs/oh-omp"><kbd><img src="../../src/assets/modelIcons/omp.svg" alt="OMP logo" width="16" valign="middle" /> OMP</kbd></a> &nbsp;
  <a href="https://pi.dev/docs/latest/providers"><kbd><img src="../../src/assets/modelIcons/pi.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a>
</p>

## Tải xuống

Phiên bản build hiện tại: v1.1.24 (2026-07-16)

Tải ứng dụng desktop ORGII mới nhất chỉ với một lần nhấp:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Trình cài đặt Windows x64](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [Tất cả tài nguyên của bản phát hành mới nhất](https://github.com/org2AI/ORG2/releases/latest)

Các liên kết tải trực tiếp luôn trỏ đến bản phát hành mới nhất trên GitHub.

## Phát triển từ mã nguồn

Để build hoặc đóng góp từ mã nguồn:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Để biết thêm chi tiết đóng góp, xem [CONTRIBUTING.md](../../.github/CONTRIBUTING.md). Chúng tôi mong mọi người tôn trọng và đồng cảm; xem [CODE_OF_CONDUCT.md](../../.github/CODE_OF_CONDUCT.md).

## Native sidecars tùy chọn

Các tính năng Browser Use và Computer Use phụ thuộc vào native helpers tùy chọn cho tự động hóa trình duyệt và tự động hóa màn hình macOS:

- `agent-browser` được tải từ releases của `vercel-labs/agent-browser` cho OS/CPU hiện tại.
- `peekaboo` được tải từ releases của `steipete/peekaboo` trên macOS.

Computer Use hiện chỉ khả dụng trên macOS. Browser Use có thể dùng `agent-browser` trên các nền tảng được hỗ trợ.

Nếu thiếu sidecar, Rust build tạo một placeholder resource nhỏ để các development builds có thể tiếp tục. Khả năng liên quan có thể fallback về `PATH` hoặc vẫn không khả dụng cho đến khi bạn chạy `pnpm run download:sidecars`.

## Cộng đồng

Có câu hỏi, phản hồi hoặc muốn theo dõi quá trình phát triển của ORG-2? Hãy tham gia Discord:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** và **#faq** — bắt đầu sử dụng
- **#announcement** — tin phát hành và cập nhật
- **#lets-chat** — chia sẻ điều bạn đang xây dựng và gặp gỡ cộng đồng
- **#feedback** — ý tưởng, yêu cầu tính năng và báo cáo lỗi

## Giấy phép

ORGII được cấp phép theo GNU Affero General Public License v3.0 hoặc mới hơn (`AGPL-3.0-or-later`). Xem [`LICENSE`](../../LICENSE) để biết toàn văn giấy phép.
