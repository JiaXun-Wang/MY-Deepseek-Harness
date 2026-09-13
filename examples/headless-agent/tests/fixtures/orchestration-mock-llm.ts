/**
 * Keyless orchestration mock: the "main model" emits one `subagent` delegation,
 * and the spawned child runs on a distinct mock adapter ("another model") and
 * returns a fixed result the main model then reports. Mirrors the real-model
 * multi-model flow with deterministic output.
 * @module multi-model-orchestration-mock
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const OFF = ReasoningEffortId('off')

/** Deterministic child adapter: replies immediately to any prompt. */
class ChildMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF } }
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const kid = 'CHILD_RESULT: the flash colleague prepared the answer it was asked for.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: kid }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: kid } }
    yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Deterministic main adapter: one `subagent` call, then a final report. */
class MainMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF } }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The spawned child's final text arrives inside the `subagent` tool-result
    // block of the last message as a nested text block. Detect that marker
    // rather than the block's (absent) name: subagent results carry text.
    const blocks = options.messages.at(-1)?.content ?? []
    const hasChildResult = blocks.some(block =>
      block.type === 'tool-result'
      && block.content.some(inner => inner.type === 'text' && inner.text.startsWith('CHILD_RESULT:')))
    // Not yet holding a child result → ask the subagent tool to dispatch the task,
    // choosing the child's executor model at call time via the `model` parameter.
    if (!hasChildResult) {
      const args = JSON.stringify({
        description: 'Hand the follow-up to the fast model',
        prompt: 'Produce the follow-up artifact the user asked for, and return it as text.',
        model: 'orchestration-child',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('orch-main-call'), name: 'subagent', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('orch-main-call'), name: 'subagent', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    // The subagent delegated, ran, and reported back into this step's history.
    const child = blocks.flatMap(block => block.type === 'tool-result' ? block.content : [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const report = `The main model delegated to a child model and received: ${child} PARENT_DONE`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: report }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: report } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 9 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Register both mock adapters on keyless providers `orchestration-main`/`orchestration-child`. */
export const name = 'multi-model-orchestration-mock'
export const inject: string[] = ['llm']

/** Register both mock adapters on keyless providers `orchestration-main`/`orchestration-child`. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['orchestration-main'], new MainMockAdapter())
  ctx.llm.registerAdapter(['orchestration-child'], new ChildMockAdapter())
}
