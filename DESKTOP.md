# HeliosGen Desktop (MyGo)

## Architecture

MyGo displays the existing React interface in the system webview. Vite produces
static HTML/CSS/JavaScript; the native executable starts the Go HTTP backend
in-process. The installed application contains no Node runtime, Next.js server,
`node_modules`, Sharp native library or application source maps.

```text
MyGo window → loopback HTTP → Go API → existing SQLite database + local media
                       └── static React frontend
```

The shell is in `desktop/`, APIs are in `internal/server/`, and the static entry
and navigation compatibility layer are in `frontend/`. Packaging uses `mygo.json`.
The existing canvas, galleries, chat, provider/model editors, theme controls,
import/export, file drops and other React components remain in use.

## Prerequisites

Build/development only:

- Go 1.27.3 or later; Go can obtain the pinned toolchain automatically.
- Node.js 22.12+ and pnpm 9; JavaScript dependencies are not installed at runtime.
- macOS packaging requires macOS; signing/notarization requires your credentials.

Runtime:

- WKWebView on macOS; WebView2 on Windows; GTK 3 and WebKitGTK 4.1 on Linux.
- `ffmpeg` and `ffprobe` on PATH for video metadata removal, trimming and frames,
  exactly as before. The shell discovers the login-shell PATH.
- `codex` and `codex-imagegen` only when enabling the optional Codex backend.
- PNG/JPEG/WebP/GIF/TIFF/BMP processing uses Go. Other image formats use macOS
  `sips`, with `ffmpeg` as a fallback; support depends on those system decoders.

```sh
pnpm install --frozen-lockfile
go mod download
pnpm desktop:doctor
```

## Development

```sh
pnpm desktop:dev
```

`scripts/desktop/dev-go.mjs` compiles a development Go server and starts it on
127.0.0.1:41731, then starts Vite on 127.0.0.1:3000. Vite proxies `/api` and
`/generated` to Go. MyGo opens the Vite origin. `pnpm dev` runs the same services
without a native window; close the app or press Ctrl+C to stop them.

Development retains `data/` and `public/generated/`. `HELIOS_DATA_DIR` and
`HELIOS_MEDIA_DIR` override those paths. Do not point tests at production data.

## Production build

```sh
pnpm desktop:build
```

The build checks the application versions and synchronized model defaults, builds
the static frontend, compiles Go and packages/signs the MyGo executable. Only
`desktop/resources/frontend/` ships as frontend resources. Artifacts are under
`build/go/<platform>-<architecture>/`; previous packages under `build/` are not
overwritten by the new default output directory.

The checked macOS arm64 1.2.1 build is approximately 20.5 MiB for the `.app` and
9.8 MiB for the DMG, compared with approximately 400.6 MiB for the earlier Node
package. Development `node_modules` and old build trees can still occupy disk
space; they are not part of the installed Go application.

The HTTP listener stays open from allocation through serving, preferring port
41730 to preserve browser storage. If occupied, it selects another loopback
port, whose browser-only storage is necessarily a different origin. MyGo keeps
the same application identity, browser profile and single-instance behavior.
No sidecar process remains alive after the native app exits or crashes.

For a static browser deployment with a Go server:

```sh
pnpm build
pnpm start
```

## Data and compatibility

### External agents / Rex

Settings → 外部互联 provides an opt-in local image-tool connection, per-task
approval, connection revocation and explicit Go CLI/Agent Skill installation.
See `docs/REX-INTEGRATION.md` for setup, capabilities and trust boundaries.
The bundled desktop executable handles `cli` before starting a native window;
no additional Node runtime or separately bundled helper is required.


| OS | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/cash.sdd.helios.desktop/` |
| Windows | `%APPDATA%\cash.sdd.helios.desktop\` |
| Linux | `$XDG_DATA_HOME/cash.sdd.helios.desktop/`, default `~/.local/share/cash.sdd.helios.desktop/` |

Go opens the existing `guest.db` using pure-Go SQLite and preserves its tables,
JSON fields and `/generated/...` URLs. Before the first Go migration of an
existing database, it creates `guest-before-go-<timestamp>.db` using SQLite's
consistent snapshot operation. Legacy `guest-db.json` and `guest-spaces.json`
imports remain idempotent. `.job-store.json` and `.codex-login-store.json` retain
their formats. Pending provider tasks resume with their original paths/settings
and the currently saved key; interrupted synchronous requests report an error
instead of remaining pending forever.

Provider keys remain local and never appear in public configuration responses.
The existing settings UI supports OpenAI Chat/Responses, Anthropic, Gemini,
custom async image/video APIs, per-model paths/authentication, parameter mappings,
reference uploads, Azure and optional Codex. Chat also accepts shared-library
image attachments for vision-capable models, without adding a tool/reasoning UI.

### Shared assets and portable configuration

Assets uses the local `shared_assets` table for searchable metadata, tags,
favorites and non-destructive removals. Uploads and all completed generation
outputs are indexed incrementally with URL deduplication. Files remain in the
same media directory and are reused by gallery references, Chat and Workflow.
Image input nodes persist durable `/generated/...` URLs; empty workflows also
survive database sync. Sync waits for the initial database read before writing,
and direct workflow URLs wait for it before validating the workflow ID. Workflow
ZIP imports validate format/version, node/edge
IDs and referenced files before uploading; upload failure does not create a
workflow containing broken bundled paths.

Settings → 导入 / 导出 backs up provider/model configurations and a whitelist of
UI/Azure preferences, not media or local logins. Desktop export invokes MyGo's
native Save dialog so the user chooses the destination; the server never accepts
an arbitrary HTTP-supplied filesystem path. Files are written atomically with
0600 permissions. Keys are opt-in plaintext; keep those backups private. Import
is size-limited, previews counts/conflicts without changing configuration and
commits merge/replace changes transactionally. Invalid imports leave the registry
unchanged. Workflow and asset backups remain separate from configuration JSON.

`pnpm desktop:check-shared` verifies isolated library indexing/removal/restart,
configuration round trips/key safety/native-save cancellation/rollback,
multimodal protocol conversion and workflow persistence/ZIP round trips.
`node scripts/desktop/shared-ui-fixture.mjs` starts a temporary mock-only app for
manual UI checks; stop it with SIGINT/SIGTERM to remove its temporary data. Never
use production credentials or the production application origin for these tests.

## Validation and legacy reference

```sh
pnpm desktop:legacy-server
pnpm desktop:check-go
pnpm desktop:check-shared
go test ./...
go vet ./...
pnpm exec tsc --noEmit --incremental false
```

The legacy Next implementation and staging scripts remain for differential
validation, not production packaging. `desktop:check-go` creates temporary data
directories and mock network/CLI services; it never reads production credentials
or makes paid generation requests. The legacy server stage must exist first.
`legacy:dev`, `legacy:build` and `legacy:start` retain the former web commands.

`scripts/desktop/check-go-media.mjs` tests real video/image processing against an
already-running isolated Go server and a real ffmpeg/ffprobe directory. Never
run it against the production origin. See `docs/GO-MIGRATION.md` for coverage and
the distinction between mocked services and real media validation.

## Signing and releases

Versions must match in `package.json` and `mygo.json`. Local macOS builds are
ad-hoc signed. Configure `macos.signingIdentity` and optionally
`macos.notarize.keychainProfile` for distribution signing/notarization. There
are no Node/Sharp helpers to sign. The update banner links to releases and does
not install updates automatically. Windows/Linux builds require target-system
validation before distribution; macOS arm64 is the package validated here.
