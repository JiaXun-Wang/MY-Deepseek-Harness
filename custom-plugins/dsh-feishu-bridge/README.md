# dsh-feishu-bridge

Feishu (Lark) bridge for DeepSeek Harness: drive one DSH session from a phone.

| Capability | Command / behaviour |
|---|---|
| Talk to the agent | Send any text in the Feishu direct chat |
| List the desktop's sessions | `/sessions` |
| Bind one session to the phone | `/open <sessionId>` (persisted; survives restarts) |
| Release the binding | `/unbind` |
| Start a fresh bridge session | `/new` (needs a released binding) |
| Connection and binding status | `/status` |
| Answer an approval request | Tap the card that arrives in the chat |

## What it is

This plugin owns one Feishu app long connection and turns it into a DSH
surface. It is deliberately a single self-contained ES module with **no build
step**: `index.js` is the artifact, so an upgrade never has to re-apply changes
to a vendored bundle.

It reaches the harness only through public seams — session persistence and
query (`/sessions`), the agent registry (`agents.get` / `agents.resume` /
`agents.create`), `agent.followup()` and `agent.ctx.on('session/event')` for
traffic, the `approval/request` waterfall for approvals, `apiProxy.respond()`
to withdraw a mirrored desktop prompt, and `ctx.credentials` for the app
credential. When one of those seams changes, this file is the place to update.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-feishu-bridge --ignore-scripts
```

The profile layer is declared by `cordis.patch.yml`, which inserts the
`feishu-bridge` row with literal config. Overrides come from the environment so
the row never depends on loader expression evaluation:

| Variable | Meaning |
|---|---|
| `DSH_FEISHU_BRIDGE_ENABLED` | `false` keeps the plugin loaded but idle |
| `DSH_FEISHU_CREDENTIAL_REF` | credential name to resolve (default `LARK_LINK_APP`) |

### Credential

The credential is a JSON string stored through `ctx.credentials`:

```json
{ "appId": "cli_…", "appSecret": "…", "domain": "feishu" }
```

The default reference `LARK_LINK_APP` matches the value written by the Feishu
app-setup flow, so an existing install keeps working without re-registering.

## Design notes

- **One long connection per app.** Remove any other Feishu bridge from the same
  profile first; two bridges holding the same app fight over the socket.
- **Colon-free session ids.** Bridge-created sessions are `feishu-dm-<chatId>`.
  Newer harness builds name one storage file per session after its raw id, and
  Windows refuses `:` in a file name.
- **Shared session.** `/open` binds a persisted session; while bound, inbound
  text is injected into it and its assistant output is pushed back, so the phone
  and the desktop show one conversation. Without a binding, each chat keeps its
  own bridge session.
- **Approvals are asked on both surfaces.** The card and the desktop prompt are
  raised together and the first answer wins. A phone answer also tries to settle
  the desktop prompt through `apiProxy.respond`; that channel is absent on newer
  harness builds, where the code degrades to answering the waterfall only.
- **Direct chats only.** Group messages are logged and ignored.

## Harness-version sensitive seams

This plugin talks to the harness through nine public seams. Review these after a
harness upgrade; the first two already differ between the release this bridge was
written on (`0.1.0-rc.5`) and later releases:

| Seam | Used for | Version note |
|---|---|---|
| `sessionPersistence.list()` | `/sessions`, `/open` | Newer builds return snapshots with the header under `.header`; normalized by `sessionHeaderOf()` |
| `ctx.get('apiProxy').respond` / `.events.mux` | withdrawing a mirrored desktop prompt | `packages/host/apiproxy` was removed upstream; both calls are optional and the feature degrades quietly |
| `sessionQuery.readTitle()` | session titles | returns a snapshot; the text is on `.title` |
| `agents.get()` / `agents.resume()` / `agents.create()` | opening a session | resumed sessions reuse the live agent when one is registered |
| `agent.followup()` | injecting phone text | |
| `agent.ctx.on('session/event')` | pushing assistant text back | committed `assistant/message` only |
| `ctx.on('approval/request')` | Feishu approval cards | answerer runs alongside the client's own answerer |
| `ctx.credentials.resolve()` | Feishu app credential | value is the JSON written by the app-setup flow |
| `@deepseek-ai/dsh-llm` `createUserMessage()` | building the injected user message | peer dependency |

Bridge-created session ids stay colon-free precisely because newer builds name a
storage file after the raw session id.


## Known limitations

- Text only: images and files are not transferred.
- No outbound retry queue: a send failure is logged, not replayed.
- Approvals are one-shot (`allowed-once`), matching the harness vocabulary.
