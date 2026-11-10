# Rex / local agent image integration

## Scope

The first local integration uses the existing Go application as an image tool.
Conversation remains in Rex (or another command-capable agent). It does not
capture terminal/chat history or expose provider API keys. The original canvas,
chat, gallery, Azure/Codex controls and generation interfaces remain available.

The external tool currently lists enabled image models saved under Settings →
服务商/图片模型, including OpenAI, Gemini and asynchronous model configurations.
Browser-only Azure deployment and optional Codex selections are not silently
inferred by the CLI. Their existing application UI remains unchanged.

This release is same-machine, same-user only. Remote Rex servers and cloud chat
clients need a separately authenticated gateway; neither CORS nor a wildcard
network listener is enabled. MCP is a follow-up adapter, not part of this release.

## Connect

1. Open the updated application and Settings → 外部互联.
2. Enable local connections and create a named connection (for example Rex Agent).
3. Choose the agent family and click 安装 CLI 和 Helios Skill. This explicit action
   writes `~/.local/bin/helios` and the selected agent's `heliosgen/SKILL.md`.
   Shared agents use `~/.agents/skills/heliosgen`; Claude uses its skills directory,
   respecting `CLAUDE_CONFIG_DIR`. Existing Rex skills/hooks are not edited.
4. Ensure `~/.local/bin` is in the shell PATH, then start a new agent session.
   For a one-session PATH setup: `export PATH="$HOME/.local/bin:$PATH"`.
5. Ask the agent to use Helios. A connection requires application-side approval
   for each generation unless you explicitly enable automatic approval. Use the
   right-hand 外部任务 entry to review it without switching to Settings.

If there are several connections, specify `helios --client CONNECTION_ID …`.
`helios connections` lists IDs without printing secrets. After moving/replacing
the application bundle, reinstall the CLI from Settings if its executable path
has changed. Automatic shell installation is macOS/Linux; Windows can call
`HeliosGen.exe cli` directly.

The installation button shows an installed checkmark and is disabled when the
CLI and the selected agent's Skill match the current application. This state is
checked from the actual files when reopening settings or restarting the app.
Missing files, a moved application or an updated Skill allow installation again;
repeating an already-current installation does not rewrite the files.

## Commands

```sh
helios --help
helios models
helios reference import --file /absolute/path/reference.png
helios image submit --request request.json
helios job get external-JOB_ID
helios job wait external-JOB_ID --timeout 120
helios job download external-JOB_ID --output /absolute/path/result.png
helios job open external-JOB_ID
```

Example request:

```json
{
  "requestId": "poster-2026-11-10-001",
  "prompt": "A clean studio product poster on a white background",
  "modelId": "default",
  "referenceIds": []
}
```

`requestId` and `prompt` are required. `modelId`, `aspectRatio`, `quality` and
`referenceIds` are optional. Use model IDs/capabilities returned by `models`;
unsupported parameters are rejected rather than silently discarded.
Reference import accepts PNG/JPEG/GIF/WebP files, up to 50 MiB, and returns an
asset ID. Completed outputs also have reusable asset IDs, scoped to a connection.

`submit` returns `jobId` and `awaiting_approval` or a generation status. Submission
pins the selected model/parameters; approval uses the existing image generation
service. Results appear in the existing gallery without a reload. `open` shows
the task/result in the right-hand panel and focuses the native application; ordinary generation does
not steal focus. Download preserves an existing file unless `--force` is used.

Wait exit statuses: 0 completed, 1 error/rejected, 2 bounded wait expired, 130
interrupted. A timeout or interruption does not cancel or resubmit a generation.
Closing the application can interrupt synchronous upstream requests. After a
restart these become errors without an automatic paid retry; persistent async
provider tasks use the existing recovery logic.

## Non-modal task panel

The right-hand task dock is part of the workspace, not a modal or a separate
window. New tasks update its count without opening it, moving focus, clearing
inputs or changing the current task selection. Opening the dock reserves space
beside the canvas/chat/gallery. Closing it does not reject or cancel a job.

Before approval, edit the prompt, configured image model, supported ratio/quality,
and references. References can be imported locally or removed; unsupported
reference counts prevent approval rather than silently dropping images. Drafts
stay in application memory across panel closing, task switching and route changes;
they are not saved to disk and do not survive an application restart. Opening the
dock shows a message-center list, with source, timestamp, abbreviated prompt,
model/parameters, status and allow/reject/detail actions on each message. Pending
and generating tasks stay in 待处理; completed, failed and rejected tasks move to
已处理. Click details to open the editable task view; successful approval or
rejection returns to the list. List approval uses any saved draft, not an older
unmodified request. Returning to the list alone preserves the draft.
A single content scroller sits between a compact header and footer. Source
context and the original request share one collapsed details block in the editor.
Approved/running tasks are read-only,
and completed outputs have previews, original downloads and a gallery shortcut.

Processed messages can be removed individually or together with 清理已处理消息.
Dismissal is persisted across application restarts and removes only the inbox
notification, not the job, its original request/idempotency identity, references,
generated gallery images or Agent query/download access. Pending and generating
tasks cannot be dismissed. An explicit `helios job open JOB_ID` can still inspect
a dismissed result without putting that message back into the inbox. The UI admin
actions are `dismiss` with `jobId` and `clear-processed` without a task ID; successful
responses contain `dismissedJobIds` so delayed refreshes cannot resurrect messages.

Ratio and quality controls only show saved model capabilities, with a highlighted
selection and checkmark. An `auto`-only model displays a fixed automatic value,
not duplicate “default” and “auto” choices. Missing quality/reference options mean
they have not been configured; the UI does not infer capabilities from a model
name. The explicit 模型参数 action opens the existing model editor for that exact
model. Save only values supported by the provider, then select them in the dock.
Saving model settings alone never approves or generates a task, and refreshes
the regular generation UI's model catalog too.

The backend retains the Agent's original request separately from the approved
configuration. It validates edits using the existing model capabilities and
connection ownership rules before atomically approving the same job ID. An
identical retry of the original request still returns that job without another
provider call. CLI results expose the effective top-level parameters,
`originalRequest`, `configurationEdited` and `approvedAt`. Existing jobs from
earlier builds retain their submitted, pinned configuration as the original.

## Rex monitor

Optional, started only when desired:

```sh
rex run --split=right --ratio 30 --focus=false -- helios jobs watch
```

The watcher runs in its own terminal and emits OSC 7501 states (`working`,
`blocked`, `done`, `error`, `idle`). It never overwrites the chat agent's own
terminal status. Piped output is JSON, not terminal escape sequences. Ctrl+C
stops the monitor without cancelling the jobs. `REX_SESSION` and `REX_BLOCK`
are attached to requests for source attribution, not used as authentication.

## Security and persistence

- Off by default; random 256-bit credentials, server-side hashes and private
  local credential files (0600). Tokens/provider keys are not included in UI
  overviews, event messages or model catalogs.
- Private discovery advertises the actual loopback port and a random instance
  ID. The CLI authenticates the instance, bypasses HTTP proxies and rejects
  redirects. It never starts a second user-data store.
- External API: `/api/integrations/v1/…`. Separate, strict request schemas do not
  permit arbitrary provider endpoints, browser settings or filesystem paths.
- Requests/assets/jobs are connection-scoped. A repeated request ID with the
  same generation inputs returns the original job; different inputs return 409.
  Source context may change on a retry without causing another generation.
- At most four unfinished requests per connection and 40 new requests per ten
  minutes. Automatic approval may incur provider charges; no exact price/budget
  guarantee is implied.
- Revocation rejects unapproved jobs and invalidates credentials. Disable or
  revoke does not promise cancellation/refund for already submitted work.
- Existing same-user loopback UI APIs remain the original local trust boundary.
  This is not isolation against a malicious process with the user's full local
  filesystem privileges. Do not expose the application port to a network.
- New SQLite integration tables are additive. Existing workflow/history formats
  are not replaced and no whole-workflow overwrite tool is exposed.

## Validation

Run `pnpm web:build` before `pnpm desktop:check-integrations` so the bundled Skill
is present. The checker uses temporary HOME/data/media, a local mock provider,
real image files and the real Go CLI. For race detection:
`HELIOS_CHECK_RACE=1 pnpm desktop:check-integrations`.
It does not read real credentials or submit paid requests. Legacy contract
regression checks remain under `pnpm desktop:check-go`.
Run `pnpm desktop:check-task-store` to verify draft retention,
non-modal selection, delayed-response handling, opening older jobs and configured
parameter choices/defaults.

## Official references

- https://www.superlogical.com/rex/docs/automate/agent-skill
- https://www.superlogical.com/rex/docs/automate/cli
- https://www.superlogical.com/rex/docs/automate/shell-scripting
- https://www.superlogical.com/rex/docs/build/program-status
- https://developers.openai.com/codex/skills
