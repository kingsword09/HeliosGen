# Static React and Go migration

The existing React components, workflows, provider configuration format, HTTP
contracts, media URLs, application identifier, SQLite schema and user-data
directory remain the compatibility baseline. The packaged application must not
require Node.js, Next.js, Sharp or a JavaScript package installation at runtime.

The legacy Next.js build stays available for differential validation. Following
the isolated checks below, Go is now the desktop default. Legacy artifacts are
not overwritten, and no real application database or running sidecar was used
for validation.

## Compatibility checklist

- [x] Static React routing/direct routes, fonts, sidebar and theme persistence.
- [x] Retained canvas/editor components; browser workflow/media ZIP roundtrips.
- [x] Existing SQLite, backup, legacy JSON imports, histories and settings.
- [x] Gallery filters, folders, uploads, deduplication, media and downloads.
- [x] Image metadata stripping, transparent thumbnails and video byte ranges.
- [x] Provider registry, per-model paths/auth, parameter mappings and templates.
- [x] OpenAI Chat/Responses, Anthropic and Gemini request-format parity.
- [x] Fragmented streaming, UTF-8, errors and cancellation; same text-only scope.
- [x] Image/video tasks, pending/settled SSE, persisted provider-task recovery.
- [x] Azure image/text and optional Codex image/login contracts implemented.
- [x] Real video upload/trim/frame processing; login-shell tool discovery.
- [x] Model listing, merged catalog/cache/offline behavior and update checks.
- [x] In-process server, retained single-instance wiring and external-link API.
- [x] Go checks, TypeScript, focused lint, production build and bundle audit.

Production continues using the same loopback origin when port 41730 is available,
so browser-only preferences and chat sessions are retained. Development uses a
separate API port; validation must never write to the real application database.

## Results and limits (2026-11-10)

- 235 API/payload/stream/storage assertions against the isolated legacy server.
- 18 additional catalog/cache/update/Replicate/Azure Auto/security assertions.
- Client streaming checks for byte-fragmented UTF-8/SSE, final partial lines,
  provider errors and reader cancellation.
- 43 real media checks: MP4 upload/range/trim/frames, and PNG/JPEG/WebP/GIF/TIFF/
  AVIF/SVG processing. FFmpeg 8.0 was built in a temporary validation directory,
  not installed globally or added to the application bundle.
- Browser checks: canvas node editing and persistence, direct route reload,
  light/dark persistence, settings, ZIP export/import including local media.
- macOS arm64 ad-hoc signed build: roughly 20.5 MiB app / 9.8 MiB DMG.

Network providers and optional CLI services were mocked for API parity; no paid
live generation or real Codex device login was attempted. Real media tests used
real local codecs. Optional ffmpeg/ffprobe/Codex prerequisites are unchanged.
Native launch was not used to displace the existing running app; Windows/Linux
and distribution signing/notarization are not validated. External template
image URLs can fail independently of the application; optimized images fall
back to direct loading before invoking the caller's error handler.
