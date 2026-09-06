---
status: active
---

# Browser cookie import (saved logins from other browsers)

The built-in Browser can carry saved logins over from another browser installed
on the machine, so sites the user is already signed in to elsewhere open signed
in inside ORGII. This mirrors the "Import cookies" affordance of the Claude
desktop app's built-in browser.

## Where it lives

| Layer | Path |
| --- | --- |
| Discovery, readers, grouping, install | `src-tauri/crates/browser/src/cookie_import/` |
| Tauri commands | `list_cookie_import_sources`, `preview_cookie_import`, `import_browser_cookies` (registered in `src-tauri/src/commands/handler_list.inc`) |
| Frontend API | `src/api/tauri/browserCookies.ts` |
| Flow + modal | `src/modules/WorkStation/Browser/ImportCookies/` |
| Entry point | "Import cookies from your browser" quick action on the Browser's blank tab (`BrowserBlankTabPlaceholder`), mounted from `WebViewport` |
| Strings | `browserCookieImport.*` in every `common.json` |

## Flow

1. **Sources.** `sources.rs` lists installed browser profiles whose cookie
   store exists on disk. Chromium profiles come from each vendor's `Local State`
   (`profile.info_cache`), with `<profile>/Network/Cookies` preferred over the
   legacy `<profile>/Cookies`. Firefox profiles come from `profiles.ini`.
2. **Preview.** The chosen store is read and (for Chromium) decrypted, then
   grouped by registrable domain. Each site row carries a category and a
   `defaultSelected` flag. Only per-site counts cross IPC — decrypted values
   never leave Rust.
3. **Import.** The store is read again for the selected domains and each cookie
   is written into the app's default `WKWebsiteDataStore` cookie store on the
   main thread via `WKHTTPCookieStore.setCookie:`. That is the same store the
   non-private inline webviews use (wry's `defaultDataStore`), so new and
   reloaded tabs see the cookies, and they persist across app launches.

## Safe defaults

Sites are checked by default except those classified as **banking**,
**email**, or **SSO / identity** (`classify.rs`), which start unchecked so the
user opts in deliberately. Classification is a substring heuristic over the
registrable domain and the observed hosts; it is a UI default only, never a
security boundary — the user always sees every site.

The registrable-domain grouping uses a short multi-label suffix list
(`co.uk`, `com.au`, …) rather than the full Public Suffix List. It is a display
convenience for the checklist.

## Decryption

Chromium on macOS encrypts values with AES-128-CBC (`v10` prefix, IV of sixteen
`0x20` bytes) under a key derived by PBKDF2-HMAC-SHA1 (salt `saltysalt`, 1003
rounds) from a per-browser password in the login keychain (`Chrome Safe
Storage` / `Chrome`, `Microsoft Edge Safe Storage` / `Microsoft Edge`, and so
on). Reading that keychain item triggers the OS consent prompt the first time;
the preview screen tells the user to expect it. Cookie databases with
`meta.version >= 24` (Chrome 130+) prepend SHA-256(host) to the plaintext; the
reader drops those 32 bytes.

Firefox stores plaintext values, so it needs no key material and works on
every platform.

Databases are opened read-only through a SQLite `file:` URI with
`immutable=1`, so a running browser holding the write lock does not block the
import and no temporary copy is needed. Un-checkpointed WAL rows are not seen;
those are the newest few cookies at most.

## Platform support

| Platform | Sources | Install |
| --- | --- | --- |
| macOS | Chrome, Edge, Brave, Arc, Vivaldi, Chromium, Firefox | `WKHTTPCookieStore` |
| Windows / Linux | Firefox only (Chromium's DPAPI / libsecret schemes are not implemented) | Not yet implemented — the import command returns an error |

Safari's cookie store lives inside a TCC-protected container and is not
offered.

## Behaviour notes

- Session cookies (no expiry) are installed as session cookies and are gone
  after the app quits, exactly as in the source browser.
- `SameSite` is read from the source but not re-applied on install: passing an
  unrecognised key to `cookieWithProperties:` can void the whole cookie, and
  WebKit's default keeps first-party requests authenticated.
- `HttpOnly` is passed through WebKit's `HttpOnly` property key.
- The modal is mounted only while open; unmounting resets the flow.
- Private (incognito) tabs do not show the action: they use a non-persistent
  data store that would not receive the cookies.
