<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Agent'ların yazılımı nasıl inşa ettiğinin kayıt sistemi.<br />Kodlama Agent’larınızı çalıştırın — herhangi bir oturumu yeniden oynatın, ekipçe inceleyin ve her satırı arkasındaki karara kadar izleyin.</strong></p>
  <p>Rust ve Tauri ile oluşturulmuş, local-first çalışmaya yönelik ve diskte 100 MB’tan az yer kaplar. Agent trajectory livestream ve replay desteği sunar. Takip etmesi ve incelemesi kolaydır.</p>
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

Bir kod parçasının neden var olduğunu — ve işe yarayıp yaramadığını — yanıtlamak her zaman birkaç sistemi elle birbirine dikmek anlamına geldi. Jira yalnızca kayıtları görür. Codex yalnızca kendi oturumlarını görür. GitHub yalnızca commit’lenen satırları görür. Amplitude yalnızca metrikleri görür. Kodu insanlar yazarken bu katlanılabilirdi. Agent hızında değil: pazartesi yazılan kod cuma günü legacy oluyor.

ORG-2, ekibinizin kodlama Agent’larını çalıştırdığı yerdir — yerleşik bir Rust harness ve 20’den fazla Agent CLI için başlatıcılar — ve bu kaydı otomatik olarak oluşturur. Her oturum, takım arkadaşlarınızın video gibi yeniden oynattığı bir trajectory hâline gelir: yalnızca diff’i değil, işin gerçekte nasıl kurulduğunu incelerler ve bağlam içinde yorum bırakırlar. Başka araçlarda çalıştırılan oturumlar da içeri alınır ve kendi geçmişlerinden geriye dönük doldurulur; böylece kayıt, uygulamadan hiç geçmemiş işi de kapsar. Kayıt; insanın ne istediğini, Agent’ın bunu nasıl anladığını ve gerçekte ne yaptığını birbirine bağlar, dolayısıyla yayına giren her satır onu yazan oturuma kadar izlenebilir.

Bu yalnızca bir AI kodlama aracı değil; insan/Agent organizasyonları ve organizasyon düzeyinde hizalanma üzerine bir deney. ORG-II, Agent’ları yapılandırılmış bir organizasyon içinde kalıcı ve gözlemlenebilir çalışma arkadaşları olarak ele alır — tekrar oynatılabilir yürütme, oturumlar arası bellek, AI blame ve local-first Rust runtime ile insanlar, Agent’lar ve ekipler ortak bağlam ve hizalanmış hedefler etrafında işbirliği yapabilir.

## Özellikler

<table>
<tr><td width="50%" valign="middle"><h3>Yerleşik Rust harness</h3><p>Mevcut API anahtarlarınız ve Agent aboneliklerinizle hızlı, token tasarruflu ve özelleştirilebilir native Agents çalıştırın.</p></td><td width="50%"><img src="../assets/feature-wall/rust-harness.gif" alt="ORG-II Rust harness ile Agents çalıştırma" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>10'dan fazla uygulama ve CLI oturumunu yönetin</h3><p>Tüm araçlarınızdaki Agent oturumlarını tek bir yerde yükleyin ve yönetin. Uygulama değiştirmeden geçmişi tarayın, subagents inceleyin ve her kaynağı kontrol edin.</p></td><td width="50%"><img src="../assets/feature-wall/session-sources.png" alt="ORG-II'de uygulama ve CLI Agent oturum kaynaklarını yönetme" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Ekibinizi kurun; yalnızca PR'ları değil, yörüngeleri inceleyin</h3><p>Ekibinizi kurun ve oturumları cihazlar ile ekip arkadaşları arasında paylaşın. Yalnızca ortaya çıkan diff'i değil, Agent'ın tüm yörüngesini inceleyin ve bağlam içinde yorum bırakın.</p></td><td width="50%"><img src="../assets/feature-wall/team-trajectory-review.png" alt="ORG-II'de ekip ve yörünge replay izinlerini yönetme" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Tool call'lar artık video olarak</h3><p>Native Rust harness ve 15'ten fazla CLI Agent'ın çalışmalarını replay edin. Mesajlar, tool call'lar, dosya düzenlemeleri ve komut çıktıları incelenebilir tek bir timeline'da senkronize kalır.</p></td><td width="50%"><img src="../assets/feature-wall/replay.gif" alt="ORG-II'de Agent oturumunu replay etme" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Yalnızca Git blame değil, AI blame</h3><p>Bir satırı kimin değiştirdiğinde kalmayın. Değişikliğe yol açan Agent oturumlarına, tool call'lara ve kararlara kadar izleyin.</p></td><td width="50%"><img src="../assets/feature-wall/ai-blame.gif" alt="ORG-II'de kod değişikliklerini Agent oturumları ve kararlara kadar izleme" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Rotada kalın</h3><p>Zamanınızı görevler ve Agent oturumları arasında nasıl harcadığınızı görün. Günlük etkinlik timeline'ı süreyi, kod değişikliklerini ve öncelikleri görünür tutar.</p></td><td width="50%"><img src="../assets/feature-wall/work-diary.png" alt="ORG-II'de görevler ve Agent oturumlarına harcanan zamanı inceleme" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Tam geliştirme workspace'i</h3><p>Agent workspace'inizden ayrılmadan terminali kullanın, kaynak kontrolünü yönetin, Git geçmişini izleyin ve pull request'leri inceleyin.</p></td><td width="50%"><img src="../assets/feature-wall/development-workspace.gif" alt="ORG-II'de kaynak kontrolü, Git geçmişi ve code review" width="100%" /></td></tr>
<tr><td width="50%" valign="middle"><h3>Design Modu</h3><p>Native WebKit tarayıcısında canlı sayfaları inceleyin. Bir öğe seçin ve kolay bir düzeltme için tam sayfa bağlamını doğrudan Agent'a gönderin.</p></td><td width="50%"><img src="../assets/feature-wall/design-mode.gif" alt="ORG-II Design Modu ile web sayfası öğesi inceleme" width="100%" /></td></tr>
</table>

## Daha fazla yetenek

- GUI, CLI, Terminal, Git, tarayıcı, LSP, timeline ve veritabanı araçları.
- Oturumlar arası bellek, Agents arası bilgi paylaşımı ve paylaşılan Workspace durumu.
- CPU, RAM ve insan dikkatinin uygunluğuna tepki verebilen kaynak farkındalıklı yürütme.
- Denetimli öz-evrim için Agent-powered GUI end-to-end testleri.
- Agents’ın gece boyunca çalışabilmesi veya siz uzaktayken işi sürdürebilmesi için scheduling ve auto-started sessions.
- İnsanları, Agents’ı, hedefleri ve accountability’yi koordine etmek için org-level alignment surfaces (WIP).
- Self-hosted Supabase üzerinden session collaboration ve grup issue workflows (WIP).

## Desteklenen Agents

ORG-II'nin yerleşik Rust harness'ını kullanın veya desteklenen coding-agent CLI'larını desktop app üzerinden başlatın.

### GUI + TUI

<p>
  <a href="#özellikler"><kbd><img src="../assets/org2-icon.svg" alt="ORG-2 logosu" width="22" valign="middle" /> ORG-2</kbd></a> &nbsp;
  <a href="https://cursor.com/docs/cli/overview"><kbd><img src="../../src/assets/modelIcons/cursor.svg" alt="Cursor CLI logo" width="16" valign="middle" /> Cursor CLI</kbd></a> &nbsp;
  <a href="https://code.claude.com/docs/en/configuration"><kbd><img src="../../src/assets/modelIcons/claude-code.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
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

## İndir

Güncel build sürümü: v1.1.24 (2026-07-16)

En yeni ORGII desktop app'i tek tıklamayla indirin:

- [macOS Apple Silicon](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-mac-apple-silicon.dmg)
- [Windows x64 installer](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64-setup.exe)
- [Windows x64 MSI](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-windows-x64.msi)
- [Linux x64 AppImage](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.AppImage)
- [Linux x64 DEB](https://github.com/org2AI/ORG2/releases/latest/download/ORG2-latest-linux-x64.deb)
- [En son sürümün tüm dosyaları](https://github.com/org2AI/ORG2/releases/latest)

Doğrudan indirme bağlantıları her zaman GitHub'daki en son sürümü gösterir.

## Kaynaktan geliştirme

Kaynaktan derlemek veya katkıda bulunmak için:

```bash
pnpm install
pnpm run download:sidecars
pnpm run tauri:dev
```

Katkı ayrıntıları için [CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına bakın. Herkesten saygılı ve empatik olmasını rica ediyoruz; [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) dosyasına bakın.

## İsteğe bağlı native sidecars

Browser Use ve Computer Use özellikleri, tarayıcı otomasyonu ve macOS ekran otomasyonu için isteğe bağlı native helpers’a bağlıdır:

- `agent-browser`, mevcut OS/CPU için `vercel-labs/agent-browser` releases üzerinden indirilir.
- `peekaboo`, macOS’ta `steipete/peekaboo` releases üzerinden indirilir.

Computer Use şu anda yalnızca macOS’ta kullanılabilir. Browser Use, desteklenen platformlarda `agent-browser` kullanabilir.

Bir sidecar eksikse Rust build, geliştirme build’lerinin devam edebilmesi için küçük bir placeholder resource oluşturur. İlgili özellik `PATH`’e geri dönebilir veya `pnpm run download:sidecars` çalıştırılana kadar kullanılamayabilir.

## Topluluk

Sorularınız veya geri bildiriminiz mi var, ya da ORG-2'nin gelişimini takip etmek mi istiyorsunuz? Discord'a katılın:

👉 **Discord: [discord.gg/tvWgAqhCzs](https://discord.gg/tvWgAqhCzs)**
👉 **WeChat: [https://github.com/org2AI/ORG2/issues/128]**

- **#how-to-use-org2** ve **#faq** — hızlıca başlayın
- **#announcement** — sürüm haberleri ve güncellemeler
- **#lets-chat** — geliştirdiklerinizi paylaşın ve toplulukla tanışın
- **#feedback** — fikirler, özellik istekleri ve hata raporları

## Lisans

ORGII, GNU Affero General Public License v3.0 veya sonrası (`AGPL-3.0-or-later`) kapsamında lisanslanmıştır. Tam lisans metni için [`LICENSE`](../../LICENSE) dosyasına bakın.
