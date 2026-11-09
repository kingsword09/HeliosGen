# HeliosGen Desktop (MyGo)

## Architecture

MyGo hosts the existing Next.js/React application in the operating system's
webview. The Go shell starts a bundled Node runtime and the standalone Next.js
server, opens a 1400×900 window, and stops the server when the app exits.

```text
MyGo window → loopback HTTP → bundled Node / Next.js → local SQLite + media
```

The shell lives in `desktop/main.go`; packaging is configured by `mygo.json`.
There is no Rust or Tauri dependency. The existing canvas, galleries, chat,
settings, external-link handling, and browser file drops stay in React.

## Prerequisites

- Go 1.27.3 or later; Go's automatic toolchain download can obtain the pinned
  version when running from an older supported Go installation.
- Node.js 22 or later, and pnpm 9.
- The system webview: WKWebView on macOS; WebView2 Runtime on Windows;
  GTK 3 and WebKitGTK 4.1 on Linux.
- Bun is optional when using `mygo.json` and the Go CLI.
- `ffmpeg` / `ffprobe` for video metadata processing, trim, and frame extraction.
- Codex and `codex-imagegen` only if enabling the optional Codex image backend.

Install JavaScript and Go dependencies:

```sh
pnpm install --frozen-lockfile
go mod download
pnpm desktop:doctor
```

## Development

```sh
pnpm desktop:dev
```

MyGo launches the Next.js development server on `http://127.0.0.1:3000` using
`scripts/desktop/dev.mjs`, then opens the native window. React updates hot-reload;
MyGo rebuilds the shell when Go files change. Close the app or press Ctrl+C to
stop development. The browser-only app is still available with `pnpm dev`.

## Production build

```sh
pnpm desktop:build
```

The build checks that `package.json` and `mygo.json` versions agree, builds
Next.js in standalone mode, and stages a clean production dependency tree and
portable Node runtime in `desktop/resources/server/`. MyGo packages these
resources and the Go shell. Artifacts are under `build/`, grouped by platform.

The shell can be cross-compiled, but this project's server staging bundles
host-platform Node and Sharp binaries. Build packages on the OS and architecture
you intend to distribute unless you also provide matching server resources.
Do not ship a different-target shell with host-platform resources.

The packaged server uses loopback port 41730 whenever available, preserving the
existing origin. If that port is occupied, it chooses a free loopback port.
A health check verifies that the local server is HeliosGen before opening it.
A parent-process guard exits the server if the desktop shell crashes.

## Provider configuration

No `.env` file is necessary. Open **Settings → API Keys → Custom Providers**:

1. Click **Add Provider** and give it a name.
2. Enter Base URL, optional API key, protocols, and image/chat/video model IDs.
3. Click **Save Provider**.
4. Choose the saved provider and click **Use This Provider** to switch.

Each provider has independent credentials, model mappings, and endpoint settings.
Switching changes new requests; running asynchronous jobs keep their original
provider ID and credentials. The first provider is activated automatically;
removing the active provider activates another saved provider when available.

The form follows the existing dark settings UI. Advanced endpoint paths,
asynchronous response paths, optional reference uploads, and payload templates
are configured in the same interface. See README's custom-provider contract.

## Local data and migration

The Go shell deliberately preserves the existing application data directory:

| OS | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/cash.sdd.helios.desktop/` |
| Windows | `%APPDATA%\cash.sdd.helios.desktop\` |
| Linux | `$XDG_DATA_HOME/cash.sdd.helios.desktop/`, default `~/.local/share/cash.sdd.helios.desktop/` |

SQLite stores workflows, generation history, folders, and provider settings.
Media is under `generated/`; desktop server logs are `desktop-server.log`.
Existing single-provider settings are migrated to a provider registry on first
load. Keys remain on the local server and are not returned to browser clients.
The new webview's browser profile may differ from the previous desktop shell;
SQLite data is retained, but browser-only preferences may need to be reselected.

## Signing and releases

Configure MyGo's platform signing fields in `mygo.json`. For macOS, set
`macos.signingIdentity` and optionally `macos.notarize.keychainProfile` for an
existing notarization credential profile. The Node helper uses
`desktop/entitlements.plist` through `macos.helperEntitlements`; native Sharp
resources must also be signed. `APPLE_SIGNING_IDENTITY` makes the staging script
sign bundled Node and native modules before MyGo packages the app.

Unsigned local macOS bundles may require Finder → Open, or `xattr -cr` on the
built app. Real distribution signing/notarization needs your own credentials.
Windows and Linux packages also require validation on those platforms.

Release versions must match in `package.json` and `mygo.json`. Run
`pnpm desktop:check-version`, then tag the matching release. The in-app update
banner links to the project's release page; it does not install updates itself.
