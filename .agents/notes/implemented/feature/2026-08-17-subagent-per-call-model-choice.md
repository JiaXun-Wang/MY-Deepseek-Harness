# Agent Note: Subagent per-call model choice

Status: implemented

English | [中文](2026-08-17-subagent-per-call-model-choice.zh.md)

## Problem

DeepSeek Harness already lets a main model dispatch sub-tasks to child agents (the `subagent` seam). The child's executor model was bound at config time: each `tool-subagent` instance pinned one `agentOptions.model`, so "fast child" and "deep child" each required a separately named tool instance. A main model that wanted to route a sub-task to `deepseek-v4-flash` or `deepseek-v4-pro` at call time — the opencode-style orchestration — had no model-visible knob.

## Decision

`dsh-tool-subagent` gains an optional `modelChoices` config: a non-empty, distinct list of model ids. When configured, the tool schema exposes an optional `model` parameter (an enum of those ids) describing that the calling model can choose the child's executor model per call. In `execute`, the chosen `model` merges into the call's `agentOptions.model`, overriding the config-time `agentOptions.model` for that call; an omitted `model` keeps the config-time model. The behavior is opt-in: without `modelChoices` the schema is unchanged and a stray `model` argument is rejected loud instead of silently ignored.

The merge rides the existing `agentOptions` contract. The in-process `spawn`/`fork` providers treat explicit `agentOptions` values as overrides of inherited parent options, so a per-call model is honored there; a remote provider owns its own child budget, and honoring a per-call model is that provider's responsibility. This is configuration responsibility, not a new capability flag — matching how `agentOptions` itself is accepted without a start-time capability gate.

Fail-loud is enforced in two layers. The arg validator enforces the schema enum before dispatch (`"model" must be one of [...]`). The execution-time guard re-checks against `modelChoices` and rejects a `model` the instance did not configure (reachable when `modelChoices` is unset and a stray undeclared-key `model` arrives, since the validator permits undeclared keys). An empty or duplicate `modelChoices` fails at plugin load so a broken enum is caught before any delegation.

## Testing

Package tests pin the model-visible contract: no `model` parameter when `modelChoices` is unset; an optional enum parameter when configured; a chosen `model` forwarded into the start request; a call-time choice overriding the config-time model for that call only; a stray `model` rejected when unconfigured; and empty/duplicate lists failing load. A keyless assembled-app scenario runs the mock main model emitting one `subagent` call with `model: "orchestration-child"`, the assembly exposing the computed `model` enum on the `subagent` tool, and the child's result folded back with the main's report — the real composition path any session would use.

## Alternatives considered

**A second `agent-choice` tool name per model.** The status quo required N tool instances for N choosable models, inflating the schema for every delegation and coupling model routing to tool-name maintenance.

**A global model-routing service.** A new Service Definition/Provider/Consumer for a shared model pool is broader than the ask; a config knob on the existing delegation tool covers multi-model dispatch in any session without a new seam.

**No validation, let the provider fall back.** That would silently run a mistyped model on the config-time model — exactly the failure `modelChoices` exists to prevent.

## Consequences

A configured `modelChoices` adds one schema parameter (and its enum) to that tool instance's request, so model-visible input grows only for instances that opt in. KV-cache prefix stability is unaffected for instances without the parameter; instances that add it invalidate parent reuse from the first changed tool definition, as any schema change would. The executor choice is per call and per request, so a model can mix `flash` and `pro` sub-tasks in one message; coordination of sibling workspace effects and provider quota remains the model's responsibility, as with every other delegation.
