<p align="center">
  <img
    src="https://raw.githubusercontent.com/SegFault42/HeliosGen/main/public/HG.svg"
    alt="HeliosGen"
    width="64"
  />
</p>

<p align="center">
  <strong>Build AI image & video pipelines visually.</strong><br/>
  Chain prompts, models, reference images, and automations on an infinite canvas.
</p>

---

# ⬇️ Download

**HeliosGen is a desktop app.** Grab the latest build for your OS from the
releases page — no account, no server, no cloud setup:

### 👉 **[Download from the Releases page](https://github.com/SegFault42/HeliosGen/releases)**

| OS | File |
| --- | --- |
| **macOS** (Apple Silicon) | `HeliosGen_<version>_aarch64.dmg` |
| **Windows** | 🙋 **looking for a contributor to build & submit** — see below |
| **Linux** | 🙋 **looking for a contributor to build & submit** — see below |

> The desktop shell now uses MyGo. Build this revision from source using the
> instructions below; older published binaries may use the previous shell.

The app is **not code-signed** yet:

- **macOS** — right-click the app → **Open** (once), or run
  `xattr -cr /Applications/HeliosGen.app`.
- **Windows** — SmartScreen: **More info → Run anyway**.

---

## 🚀 First run

1. Launch HeliosGen.
2. Open **Settings → 服务商**, enter your API URL and optional API key, and click **保存连接**. OpenAI-compatible format is selected by default; choose a native format only when the provider requires it.
3. Open **图片模型**, **视频模型**, or **对话模型** and add only the models you need. One model in one category is enough to get started.

Everything stays on your machine. Generations, uploads, folders, workflows and
settings live in a local database; media is saved to a local folder:

| OS | Data location |
| --- | --- |
| macOS | `~/Library/Application Support/cash.sdd.helios.desktop/` |
| Windows | `%APPDATA%\cash.sdd.helios.desktop\` |
| Linux | `~/.local/share/cash.sdd.helios.desktop/` |

Delete that folder to reset the app.

---

# 📸 Screenshots
## ✨ Simple Image & Video Generation

<p align="center">
  <img width="2912" height="2292" alt="Image generation example" src="https://github.com/user-attachments/assets/8263b83d-addb-4af8-99d1-d8406c52be2c" />
</p>

---

## 🔄 Workflow Generation

<p align="center">
  <img width="1459" height="1146" alt="Workflow generation example" src="https://github.com/user-attachments/assets/fc7f1109-76d1-4af0-b91d-0e915bcf5461" />
</p>

---

## 🧠 Native JSON Prompt Preview

<p align="center">
  <img width="886" alt="JSON prompt preview" src="https://github.com/user-attachments/assets/dedbdf4f-9d52-4e29-ad6e-a2e67e341a73" />
</p>

---

## 💬 AI Prompt Improvement Assistant

<p align="center">
  <img width="872" height="502" alt="Prompt assistant interface" src="https://github.com/user-attachments/assets/17ba972c-bd8a-49a7-b367-4ef906fe3e17" />
</p>

# ✨ HeliosGen

HeliosGen is a free & open source visual AI workflow builder for image and video generation.

Build reusable AI pipelines with:
- infinite node-based workflows,
- multi-model generation,
- reference images,
- automation chains,
- all running 100% locally on your machine.

Choose your provider. Keep your workflows and media on your machine.
Prompts and reference media are sent only to the provider you configure;
usage charges and account requirements are determined by that provider.

---

# 🔌 Custom Provider

Open **Settings → 服务商** or any model category, click **添加供应商**, enter an **API 地址** and optional
**API Key**, then click **保存连接**. A display name is optional. The single
**接口格式** setting fills protocol, endpoint, and authentication defaults for
OpenAI-compatible, native Gemini, or native Anthropic connections. Custom async
APIs require the endpoint/template settings described below.

Image, video, and chat models have separate configuration pages. Only configure
the category you need; no image/chat/video model-ID fields are required in the
connection form. Every category uses a left-hand provider list and right-hand
connection/model details. You can add a provider directly on any category page,
then save its connection and add models without leaving that page. A connection
can be shared across image, video, and chat models.

All enabled models from all saved providers appear in the model picker, grouped
by provider. Selecting a model routes the request to its own provider and API key;
no global provider switch is needed. Image, video, and chat have independent
default providers, and each provider has its own default model per category.
Browsing a provider in settings does not change these defaults. Disabled or
deleted models cannot receive new requests. Unconfigured catalog presets are not
advertised as usable models; optional Azure/Codex image models appear only after
selecting their backend. No `.env` file is required.

Unsaved connection/model edits require confirmation before changing providers,
categories, or closing settings. Provider deletion removes that provider's models
and key across all categories, with confirmation; other providers are unchanged.

Keys are saved in the local SQLite database and are not returned by the settings
API or saved in browser storage. Leave the key input blank to keep a saved key;
use **清除已保存的 Key** and save for an unauthenticated local provider.

## Supported protocols

- **Images — OpenAI compatible:** JSON `POST images/generations`; reference-image
  edits use multipart `POST images/edits`. Responses must contain `data[]` with
  `b64_json` or `url`. Base URL includes the API prefix, for example
  `https://your-provider.example/v1`.
- **Images — Gemini native:** `POST models/{model}:generateContent`, inline
  reference images, and image bytes from candidate `inlineData` parts. Use the
  native API's base URL, for example
  `https://generativelanguage.googleapis.com/v1beta`. The configured model must
  support image output.
- **Chat:** OpenAI-compatible streaming Chat Completions, OpenAI Responses, Gemini
  native streaming, or Anthropic native streaming messages. The adapters use
  Undici/fetch directly and normalize text streams for the UI; no provider SDK
  is required. Responses uses `POST responses` with `input`, `stream: true`, and
  optional `max_output_tokens`, including text and refusal deltas. Failed or
  incomplete responses fail the stream instead of silently completing. Select
  **OpenAI Responses** as the provider's chat default or as a text model's
  independent **接口方式**. The API address includes the prefix (such as `/v1`),
  not `/responses`; per-model paths and authentication overrides still apply.
  Requests default to `store: false`; `extraBody.store` can explicitly override
  this. This adapter handles text conversations, not Responses tools or image
  generation. Existing OpenAI-compatible chat configurations remain unchanged.
- **Images / video — custom asynchronous JSON:** configure submission and polling
  endpoints, response field paths, and optional request templates. Video uses
  this protocol; a chat-compatible endpoint alone does not provide video support.

The standard **API Key** field is optional. By default, OpenAI/task requests use
`Authorization: Bearer ...`, Gemini uses `x-goog-api-key`, and Anthropic uses
`x-api-key`. `authHeader` and `authPrefix` can override authentication.
Endpoints must stay on the configured origin; credentialed redirects are rejected.

### Mixed interfaces under one provider

A provider owns the shared API address and Key, not a single mandatory protocol.
For example, add one gateway with `https://gateway.example/v1`, then:

- Add a GPT Image model and leave **接口方式 → 跟随供应商** (OpenAI compatible).
- Add a Gemini image model, select **Gemini 原生**, and set **接口前缀** to
  `/v1beta` if that is the gateway's documented prefix.
- If the gateway requires Bearer authentication for its Gemini endpoint too,
  expand **路径与认证覆盖** and choose **Bearer Key**. Otherwise native Gemini
  authentication is selected automatically, while custom provider headers are preserved.

The model editor previews the actual POST URL without exposing the Key. Model rows
show their effective protocol and whether they inherit or override the connection.
Chat models can likewise mix OpenAI, Gemini, and Anthropic under one provider;
video models use asynchronous task endpoints. Image and chat default protocols
are independent, and browsing or editing a model never switches other models.

Only the model ID is required in the default case. Per-model **接口前缀**, request
paths, authentication, task response fields, and task payload templates are optional.
Prefixes such as `/gateway/v1beta` replace the API path on the same origin;
endpoint paths are relative to that prefix. Cross-origin model overrides and
per-model API Keys are deliberately disallowed. A different host or Key should
be saved as a separate provider.

Changing a model's protocol prompts before clearing its old optional parameters
and independent paths. Changing a provider's default protocol leaves explicitly
configured model protocols alone; inherited models with old parameter definitions
are blocked until their parameters are reset and reconfigured. Existing settings
continue to inherit their previous protocol without re-entry. Running async jobs
retain the original model-specific paths, authentication mode, and response mapping.

## Fetch and configure models

After saving a connection, open **Settings → 图片模型 / 视频模型 / 对话模型**,
select the provider, then click **拉取模型**. Model-list requests run on the local server
using the saved API key. OpenAI-compatible lists, paginated Gemini lists, and
paginated Anthropic lists are supported. The endpoint and format use connection
defaults. Override `modelsPath`, `modelsProtocol`, or `modelsResultPath` in the
collapsed **名称与高级连接设置** only if your provider uses a different model-list API.

Search the fetched catalog and click **添加为图片 / 视频 / 对话**. Model
types inferred from names are only suggestions, not verified capabilities. If a
provider has no model-list endpoint, use **手动添加** instead. The exact upstream
**模型 ID** is the only required model field; display names and capabilities are
optional and collapsed. Click **保存模型** once; there is no second provider-save
step. The first enabled model becomes the default automatically. **设为默认**
changes the initial/fallback selection, not an existing valid user selection.

Models are stored locally with that
provider, survive app restarts, and appear in gallery, chat, quick-assist, and
workflow-node selectors for every saved provider. Models can be edited,
disabled, or removed without changing source files. Built-in/backend settings
remain available in collapsed optional sections. Old default model-ID settings
are migrated into the model list without requiring re-entry.

### Model parameter compatibility

New models use conservative defaults: only the required prompt/model request
fields are sent (plus required protocol fields), with optional generation
parameters off. Expand **支持的参数** and enable only what the provider documents:

- Images: exact pixel-size mappings or native aspect ratios, quality/output-size
  values, and maximum reference-image count. OpenAI image sizes must be mapped
  explicitly, such as `1:1=1024x1024, 3:2=1536x1024`; a 3:2 size is not silently
  substituted for 16:9. Gemini native image-size values use `1k`, `2k`, `4k` when
  the selected model supports them.
- Video: allowed duration values (an exact list, not a continuous range),
  resolution values, sound, first/last frames, supported reference media, and
  separate reference-image/video/audio count limits.
- Chat: optional maximum output tokens. Native Anthropic requires `max_tokens`;
  when unset, the adapter supplies 1024 instead of assuming every model supports
  an 8192-token output limit.

Disabled controls are hidden in gallery/workflow generation UI and their
automatically constructed parameters are omitted upstream. Enabled values are
validated server-side, including custom default aliases and reference limits.
Unsupported values/media are rejected instead of being forwarded to the model.
Fetching model IDs does not prove capability support; verify against the
provider's model documentation.

For nonstandard fields, the model's collapsed **自定义参数名与固定参数** editor
accepts `parameterKeys` (logical `aspectRatio`, `quality`, `duration`, `resolution`,
`sound`, `maxOutputTokens` to upstream field names) and `extraBody` (explicit fixed JSON fields).
For example, a task video model can use
`{"parameterKeys":{"duration":"seconds"},"extraBody":{"watermark":false}}`.
For native Gemini, aspect-ratio/quality key mappings apply inside `imageConfig`.
Fixed fields and provider request templates are explicit user overrides and
must also match the upstream API; capability toggles do not validate arbitrary
hardcoded JSON.

## Advanced endpoints and request templates

On a provider's **连接设置**, expand **高级连接设置**. Paths are
relative to Base URL, including paths that begin with `/`. An async example:

```json
{
  "imagesPath": "image-tasks",
  "videoPath": "video-tasks",
  "statusPath": "tasks/{id}",
  "taskIdPath": "job.id",
  "taskStatePath": "job.status",
  "taskOutputPath": "job.output",
  "imageBody": {
    "model": "{{model}}",
    "input": {
      "prompt": "{{prompt}}",
      "images": "{{image_urls}}",
      "aspect_ratio": "{{aspect_ratio}}"
    }
  },
  "videoBody": {
    "model": "{{model}}",
    "prompt": "{{prompt}}",
    "duration": "{{duration}}",
    "first_frame": "{{start_frame_url}}"
  }
}
```

Select **Async / custom JSON** for async images. Submission returns a task ID,
for example `{"job":{"id":"123"}}`. Polling uses GET; successful states are
`success`, `succeeded`, `completed`, or `done`; failure states include `failed`,
`error`, and `cancelled`. The output field accepts URLs, arrays of URLs, or image
objects containing `url` / `b64_json`. Output is downloaded to local storage.
Remote task IDs and nonsecret provider configuration are saved so polling can
resume after restarting the app. Synchronous requests interrupted by a restart
must be generated again. Changing default providers does not interrupt outstanding tasks: each retains
its original provider ID. If that provider is removed or its Base URL changes,
restore it before resuming its tasks.

Without a request template, async submission uses a flat JSON body. Available
exact-value placeholders are `{{model}}`, `{{prompt}}`, `{{image_urls}}`,
`{{aspect_ratio}}`, `{{quality}}`, `{{duration}}`, `{{resolution}}`, `{{sound}}`,
`{{start_frame_url}}`, `{{end_frame_url}}`, `{{video_ref_url}}`,
`{{reference_video_urls}}`, and `{{reference_audio_urls}}`. Arrays and numbers
keep their types; a string exactly matching a placeholder is replaced.

Reference media is sent inline as data URLs by default. If your async provider
requires public reference URLs, configure `uploadPath`: it must accept
`{"file":"data:...;base64,..."}` and return a URL at `uploadResultPath` (default
`url`). Other upload contracts require an adapter change. Standard OpenAI
multipart video endpoints are not the same as this JSON task contract.

`modelMap` maps existing UI preset IDs to upstream IDs, for example
`{"gpt-image-2":"your-image-model"}`. Unmapped presets send their UI ID;
**Custom ... Model** entries use the configured model IDs. Presets do not imply
that your provider supports every listed model. Azure Foundry and Codex CLI
remain optional image backends.

Model settings automatically fetch the selected provider's model list when opened.
New upstream models appear in that list without updating the app; add only the
models you want to use. Existing defaults and manually configured parameters are
never replaced by a refresh.

If a model is missing, expand **在线参考目录**. This catalog combines the public
Vercel AI Gateway and models.dev catalogs, caches results locally for six hours,
and supports manual refresh and offline fallback. It requires no catalog API key
and sends no provider credentials to either directory. Catalog lookup does not
route generation through Vercel. Importing opens the model editor so you can
confirm the ID used by your own provider before saving. GPT Image 2.6 Flare and
Sunburst can be imported with their official `gpt-image-2.6-flare` and
`gpt-image-2.6-sunburst` IDs; they appear in the generation picker only after
adding and enabling them for a provider.

Catalog modality metadata is not a complete parameter specification. Image input
support does not establish image-count limits, sizes, quality values, video
durations, or endpoint compatibility. Imported models keep optional parameters
disabled until configured from your provider's documentation.

---

# 🚀 Features

- Infinite node-based canvas
- AI image & video generation
- Drag-and-connect workflow system
- Multi-model pipelines
- Reference image support
- Parallel & sequential pipeline execution
- Real-time generation history
- 100% local — your data never leaves your machine
- Bring your own provider, API endpoint, and models
- Modern responsive UI

---

# ⚡ Model Presets

## Images
- GPT Image 2 (OpenAI)
- Nano Banana / Nano Banana 2 / Nano Banana 2 Lite / Nano Banana Pro (Google)
- Seedream 5.0 Lite / Pro (Seedream)
- Z-Image (Z-AI)
- Grok Imagine (X)

## Videos
- Veo 3.1 Lite / Fast / Quality, Gemini Omni Video (Google)
- Kling 3.0, Kling 3.0 Turbo, Motion Control 2.6 / 3.0 (Kling)
- Seedance 2.0 / Fast / Mini (Bytedance)
- Grok Imagine, Grok Imagine 1.5 preview (X)
- HappyHorse (Alibaba)

More models are coming.

---

# 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | MyGo (Go + system webview) |
| App | Next.js + React + TypeScript (bundled Node sidecar) |
| Database | SQLite (local) |
| Storage | Local disk |
| AI Backend | Configurable custom providers / Azure Foundry / Codex CLI |

---

# 🤖 Codex CLI (optional — alternate GPT Image 2 backend)

Instead of routing GPT Image 2 through your custom image API, HeliosGen can generate through your own ChatGPT Codex subscription via [`codex-imagegen-cli`](https://github.com/jdmnk/codex-imagegen-cli). The desktop app picks up `codex` from your `PATH` automatically; if it's missing, the feature just shows **NOT CONFIGURED** and everything else keeps working.

Requirements:
- A ChatGPT Plus/Pro/Team/Enterprise account with Codex access
- [`codex`](https://github.com/openai/codex) CLI installed on your machine
- [`uv`](https://docs.astral.sh/uv/) (Python package manager)

### 1. Install the Codex CLI

```bash
# macOS
brew install codex

# or, cross-platform
npm install -g @openai/codex
```

### 2. Install codex-imagegen-cli

```bash
git clone https://github.com/jdmnk/codex-imagegen-cli.git
cd codex-imagegen-cli
uv sync --dev
uv tool install -e .
```

This installs the `codex-imagegen` binary — make sure it's on your `PATH`.

### 3. Log in

Either:
- run `codex login` in a terminal (opens a browser to sign in), **or**
- open the app → **Settings → 服务商 → Azure / 本地 Codex → Codex CLI → Connect Codex**, which walks you through a device-code login — visit the printed URL and enter the code, no terminal needed.

> ⚠️ Starting a new login (either way) immediately invalidates any existing session on that machine — the CLI clears old credentials the moment a login attempt begins, whether or not it's ever completed. Only start one when the status badge below shows **NOT CONFIGURED**.

### 4. Enable it for GPT Image 2

In **Settings → 图片模型 → 内置模型与其他后端**, set GPT Image 2's provider toggle to **Codex CLI**. The status badge in **Settings → 服务商 → Azure / 本地 Codex** shows **READY** once both the CLI and login are in place.

---

# 🛠️ Build from source

The desktop shell uses **MyGo**, not Tauri. The Next.js/React frontend and local
Node server are preserved, so you can also run the project in a browser.

Prerequisites: **Node.js 22+**, **pnpm 9**, **Go 1.27.3+**, and the system webview.
Go can download the pinned toolchain automatically. Linux needs GTK 3 and
WebKitGTK 4.1; Windows needs WebView2 Runtime. Video tools need `ffmpeg`/`ffprobe`.

```bash
pnpm install --frozen-lockfile
go mod download
pnpm desktop:doctor
pnpm desktop:dev
```

For a packaged build:

```bash
pnpm desktop:build
```

Artifacts are written under `build/`. Build on the target OS/architecture because
the bundled Node and Sharp dependencies are platform-specific. MyGo settings
are in `mygo.json`; the shell is in `desktop/main.go`. No Rust toolchain is needed.

For browser-only development:

```bash
pnpm dev
```

All provider configuration is available through the existing **Settings** UI.
See `DESKTOP.md` for data-directory migration, packaging, signing, and release
version checks.

---

# 🤝 Contributions

Contributions are welcome.

If you find a bug, have an idea, or want to improve HeliosGen:
- Open an issue
- Submit a pull request
- Share feedback or feature requests

All contributions are appreciated.

---

# 📄 License

MIT License

---

<p align="center">
  Built for creators building the future of AI workflows.
</p>
