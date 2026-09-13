# Multi-Model Collaboration: A Main Model Dispatches Tasks to Child Models

English | [中文](multi-model-orchestration.zh.md)

> Status: **design / feasibility proposal (under review)**. Reference project: [sst/opencode](https://github.com/sst/opencode).

## 1. The Requirement

The original request (translated): implement "multi-model collaboration" in DeepSeek Harness so that **a main model can dispatch sub-tasks to other child models and fold their results back**.

Critical nuance: DeepSeek Harness **already has mature main-agent-to-child-agent delegation**. The need is not greenfield. The real gaps are:

1. **Model-routing model experience**: the `subagent` tool is bound to a provider/transport; the model cannot pick *which mental model* executes.
2. **Dynamic routing**: opencode lets the main agent pass a `model` field per call; here routing is bound at config time (one tool instance is pinned to one model).
3. **Composable orchestration primitives**: surface dispatch + aggregation + retry + result merging as model-friendly primitives closer to opencode's `agent`/`task`.

## 2. Reference: What sst/opencode Does

[opencode](https://github.com/sst/opencode) ([DeepWiki](https://deepwiki.com/sst/opencode)) is an open-source, agentic coding terminal. Its multi-model orchestration core:

- A **primary agent** drives the session, plans, and schedules.
- **Sub-tasks / sub-agents**: the primary spawns child agents via `agent`/`task`/`subtask`-style tools; each child has an independent context and reports back.
- **Model selection**: opencode lets each agent pick its model in config and, in some delegation tools, override the child model at call time ("runtime model override", e.g. [PR #35800](https://github.com/anomalyco/opencode/pull/35800)).
- **Ecosystem orchestration**: community work adds role-based multi-agent workflows (e.g. [gstack-opencode](https://github.com/yandong2023/gstack-opencode), the [Subtask2 plugin](https://augmenter.dev/articles/subtask2-plugin-brings-structured-orchestration-to-opencode-commands-1768907873438/)) and [plugin-based parallel orchestration](https://github.com/anomalyco/opencode/issues/20849).

Relevant borrowings for this project:

| opencode capability | Borrowing |
|---|---|
| Delegation tool + optional model override param | Let the model pick the executor model at call time |
| Child independent context + result return | Corresponds to spawn/fork + `.result`/`report` |
| Primary/child separation + roles | Corresponds to persona / tool filter / depth cap |

## 3. Existing Capabilities (DeepSeek Harness Today)

No greenfield build is needed. Already present:

- **`subagent` seam** (`packages/subagent/`):
  - Child transports: `spawn` (fresh child), `fork` (inherits parent's completed turns), `acp` (cross-process ACP), `codex`, `claude-code`, `dsh-sdk`.
  - Model-facing tools: `tool-subagent` (default name `subagent`, multi-instance multi-toolName), `tool-subagent-control` (`send_message`/`interrupt_agent`/`list_agents`), `tool-subagent-report` (child-to-parent report).
  - Capabilities: `persona`, `toolFilter`, `maxDepth`, `outputSchema` (structured return), `backgroundMode` (foreground / one-shot background / continuable).
- **`workflow` seam** (`packages/workflow/`): a model-written JavaScript orchestration script fans out many sub-agents via `agent()`.
- **`plan`** (`packages/plan/`): logged state constraining the main agent to plan first.
- **`context`** plugins and `todo_write`: request-context processing and task tracking.
- **`agent-spine-demo` bundle** (`packages/examples/agent-spine-demo/`): packs common services into one plugin; leaves compose a runnable app by adding the LLM adapter / bash executor etc.
- **Entry points**: headless one-shot, ACP automation, JSON-RPC, and the Web app.

Conclusion: "main agent = main model, dispatch to child agents" is **implemented and mature**. This proposal focuses on enhancing model routing and orchestration experience, not rebuilding.

## 4. Gap Analysis

| Dimension | Today | Desired (aligned with opencode) | Proposal |
|---|---|---|---|
| Choose model at call time | Tool instance pins `agentOptions.model`; model cannot choose executor | Delegation tool returns an optional `model` parameter; main picks pro or flash by task size/cost | Enhance `tool-subagent` schema: optional `model` param constrained to registered models |
| Multiple delegation ports | Requires configuring several distinct-`toolName` instances | One port + model choice | Follow the previous; keep multi-instance for config-time pinning |
| Result merge orchestration | Main coordinates itself; `report`/continuable exist | More structured orchestration abstraction | Provide a "roadmap" and pure-component reuse, not a forced abstraction |
| Child backends | In-process spawn/fork or external processes | Mixed backends coexist | Already supported; reuse |
| Visualization/observability | Session logs, `list_agents` | Orchestration DAG panel | Optional later milestone |

## 5. Design

### 5.1 Core model

```
User -> main agent (e.g. deepseek-v4-pro)
          |  identifies task, decomposes, decides routing
          |- subagent(description, prompt, model?: pro|flash)   -> deep model
          |- subagent(description, prompt, model?: flash)       -> fast model
          `- waits / folds child results -> reports to user
```

- **Main agent**: the session's active party, plans and schedules.
- **Child agent**: an independent session (`spawn` fresh or `fork` inherited) that completes the delegated work and returns via `.result`/`report`.
- **Routing**: an optional per-call model override combined with a config-time default.

### 5.2 Recommended landing: enhance `tool-subagent`

In `packages/subagent/tool-subagent/src/index.ts`, add to `Config`:

```ts
type EnhancedToolSubagentConfig = {
  /** Let the model choose the executor model per call. Each value must be a registered model id. Omitted uses the config-time `agentOptions.model` or the parent agent's model. */
  modelChoices?: string[]
}
```

- Scope (optional): a new optional tool param `model: string` whose enum is constrained by `modelChoices`; merge the choice into `agentOptions` at `execute`.
- Capability check: only show the param when the bound provider supports `agentOptions` override (in-process spawn/fork). Otherwise fail loud.
- Semantics: dynamic executor selection is the core alignment with the "main dispatches to many models" goal.

> Note: an incremental enhancement to the existing `subagent` seam; does not change transport, context, or lifecycle semantics — consistent with "plugins, not loop changes".

### 5.3 Other orchestration primitives (optional, not M0)

- **`workflow`** as the large-scale fan-out port: exists.
- **`plan` + `todo`** as main-agent planning aids: exist.
- **`report`/continuable** as long-running background children: exist.

M0 does not need a new orchestration abstraction; reuse `subagent` + `workflow` covers most "main dispatches to children" scenarios.

## 6. Runnable Minimal Example

See the orchestration fixture under `examples/headless-agent/` — two ways to run:

1. **Keyless mock** (default, no API key): a mock main model emits one `subagent` delegation; the spawned child runs on a distinct mock adapter ("another model") and the chain main → child → report is asserted.
2. **Real model**: point the main agent at `deepseek-v4-pro` and bind the dispatch tools to `deepseek-v4-pro` / `deepseek-v4-flash`; with a `DEEPSEEK_API_KEY`, run the real multi-model flow "pro dispatches to flash/pro".

### 6.1 Run keyless

```sh
pnpm run test:e2e -t "multi-model orchestration"
```

### 6.2 Run against real models

```sh
DEEPSEEK_API_KEY=... node --import tsx/esm examples/headless-agent/tests/fixtures/headless-driver.ts examples/headless-agent/multi-model-real.cordis.yml "Split the task: hand X to the flash colleague and Y to the pro colleague."
```

## 7. Milestones

| Milestone | Scope | Estimate |
|---|---|---|
| M0 (this proposal + example) | Design review + keyless mock + real-model config | shipped here |
| M1 call-time model selection | Enhance `tool-subagent` schema (`modelChoices` + optional `model` param) + unit/snapshot tests + README | small |
| M2 orchestration guide | Chinese cookbook: how a main agent plans and dispatches to several models in one session | medium |
| M3 (optional) visualization | Orchestration DAG / child panel | large |

## 8. Risks and Open Questions

- **Dynamic model vs cache prefix stability**: prefix stability is unaffected (children have separate sessions); state that KV-cache semantics do not cross models — consistent with "different models, different contexts".
- **Fail-loud semantics**: an invalid model id must be rejected before dispatch (schema/tool layer), never silently fall back.
- **Authority/depth boundaries**: dynamic model choice must not widen `maxDepth`, `toolFilter`, or authority inheritance; it changes the executor, not the authority.
- **Cost**: pro→flash saves; flash→pro costs. Whether to cap by default is a deployment policy, left to config (no hardcoded default).

## 9. Conclusion

"Main model dispatches tasks to other models" is **highly feasible with a small surface**: an incremental enhancement to the mature `subagent` seam for per-call model selection. This proposal ships a **keyless, runnable** minimal example; provide a `DEEPSEEK_API_KEY` to switch to real DeepSeek multi-model orchestration.
