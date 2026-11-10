---
name: heliosgen
description: Generate or edit images through the user's local HeliosGen application, using its configured models and reference images. Use when the user asks to use Helios or the connected local image generator.
---

# HeliosGen

Keep conversation in the current agent. Use `helios` for image work; do not operate GUI buttons, read application databases or provider credentials, or change provider configuration.

Run `helios --help` and `helios models` to discover this installation's commands and enabled models. The application must be running and its external connection enabled. If unavailable, ask the user to open Helios and configure Settings → 外部互联. Do not start another application data store.

Submit a JSON request using `helios image submit --request request.json`. Required: `requestId` and `prompt`. Optional: `modelId`, `aspectRatio`, `quality`, `referenceIds`, `source`. Obtain model IDs and supported parameters from `helios models`. Omitted modelId selects the application's default configured image model.

Include `source.name` identifying the current agent when known, for example `"source":{"name":"codex"}` (or `claude-code`, `opencode`, `pi`). Do not infer the agent from a connection nickname or Rex terminal. If unknown, omit the name. This is informational metadata, not authentication. `helios` attaches Rex session/block context independently when available, including when you supply an agent name; a Rex environment alone does not identify the agent.

Choose one stable unique requestId for each user-intended generation. Reuse that ID and the identical request if a network retry is needed. Never automatically resubmit a failed or denied generation with a new ID: it may incur another charge.

Import a user-requested local reference with `helios reference import --file /absolute/path/image.png`; put the returned assetId in referenceIds. Reuse existing asset IDs when editing previous outputs. Do not send arbitrary remote URLs or server-side filesystem paths.

Submission returns a jobId. `awaiting_approval` means the user must open the right-hand 消息中心 in Helios and approve the task, not that generation failed. The user can open task details and adjust generation parameters before approval. Approval/rejection returns to the message list. Completed, failed or rejected messages can be cleared without deleting the underlying task or images; inboxDismissed does not mean generation failed or the task was cancelled. Job results return the effective parameters plus originalRequest and configurationEdited; do not resend edited inputs as a retry of the original request. Use `helios job wait JOB_ID --timeout 120` for a bounded wait or `helios job get JOB_ID` for a snapshot. A wait timeout does not cancel or resubmit the job. The agent can continue other work while the job runs.

Completed jobs contain output asset IDs and image URLs. Download an original with `helios job download JOB_ID --output /absolute/path/output.png`, and use the agent's image-viewing capability when available. `helios job open JOB_ID` explicitly brings the result into Helios; do not steal focus without the user's intent. Do not claim a terminal or chat client can display an image unless it actually can.

Optional Rex monitor: `rex run --split=right --ratio 30 --focus=false -- helios jobs watch`. This is a dedicated terminal for progress; preserve the user's other terminals and Rex Skill/Hook configuration. The watcher emits OSC 7501 states only to a terminal, never into JSON tool output.
