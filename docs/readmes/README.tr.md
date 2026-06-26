<div align="center">
  <h1>ORG-2</h1>
  <p><strong>Cursor tarzı open-source Agent IDE — yalnızca daha hızlı kodlama için değil, incelenebilirlik, izlenebilirlik ve yaratıcı özgürlük için tasarlandı.</strong></p>
  <p>Rust ve Tauri ile oluşturulmuş, local-first çalışmaya yönelik ve diskte 100 MB’tan az yer kaplar. Agent trajectory livestream ve replay desteği sunar. Takip etmesi ve incelemesi kolaydır.</p>
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

Bu yalnızca başka bir AI kodlama aracı değildir; insan/Agent organizasyonları ve org-level alignment üzerine bir deneydir. Agents daha iyi hale geliyor, ancak collaboration, observability, yapı ve paylaşılan accountability aynı hızda ilerlemiyor — bazı durumlarda daha da kötüleşiyor. Cursor, Claude Code ve benzeri araçlar Agents’ı çoğu zaman dış kaynaklı asistanlar gibi ele alır: çıktı üretmek için yararlı, ancak sistem düzeyinde denetlemesi, koordine etmesi, hizalaması veya geliştirmesi zordur.

ORG-II farklı bir modeli araştırır: yapılandırılmış bir organizasyon içinde kalıcı ve gözlemlenebilir çalışma arkadaşları olarak Agents. Durumsuz ve incelemesi zor AI IDE sessions yerine, tekrar oynatılabilir Agent execution, oturumlar arası bellek, AI blame ve local-first Rust runtime sunar; böylece insanlar, Agents ve ekipler ortak bağlam ve hizalanmış hedefler etrafında işbirliği yapabilir.

## Temel yetenekler

- Denetim, inceleme ve hata ayıklama için tekrar oynatılabilir execution traces içeren uzun süreli sessions.
- Mevcut API keys ve Agent aboneliklerinizle çalışan Rust tabanlı Agents.
- GUI, CLI, Terminal, Git, tarayıcı, LSP, timeline ve veritabanı araçları.
- Oturumlar arası bellek, Agents arası bilgi paylaşımı ve paylaşılan Workspace durumu.
- CPU, RAM ve insan dikkatinin uygunluğuna tepki verebilen kaynak farkındalıklı yürütme.
- Denetimli öz-evrim için Agent-powered GUI end-to-end testleri.
- Agents’ın gece boyunca çalışabilmesi veya siz uzaktayken işi sürdürebilmesi için scheduling ve auto-started sessions.
- İnsanları, Agents’ı, hedefleri ve accountability’yi koordine etmek için org-level alignment surfaces (WIP).
- Self-hosted Supabase üzerinden session collaboration ve grup issue workflows (WIP).

## İndir

En yeni ORGII desktop app’i [Releases](https://github.com/YORG-AI/ORGII/releases) sayfasından alın. En yeni release’i açın, platformunuza uygun installer veya app bundle’ı indirin ve ORGII’yi kurmak için işletim sistemi yönergelerini izleyin.

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

## Lisans

ORGII, GNU Affero General Public License v3.0 veya sonrası (`AGPL-3.0-or-later`) kapsamında lisanslanmıştır. Tam lisans metni için [`LICENSE`](../../LICENSE) dosyasına bakın.
