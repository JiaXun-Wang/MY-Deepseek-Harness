/**
 * Assembled-app keyless test for the multi-model orchestration demo: a mock
 * main model emits one `subagent` delegation, chooses the child's executor model
 * at call time via the tool's `model` parameter, the spawned child runs on that
 * chosen "another model" adapter, and the main model reports the child's result.
 * Proves the main → child dispatch + per-call model routing loop end to end
 * without any API key.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/orchestration.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('multi-model orchestration demo (keyless)', () => {
  it('runs the main agent -> child model delegation loop and reports the child result', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'multi-model orchestration',
      tempDirPrefix: 'dsh-orchestration-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Ask the fast model to produce the follow-up artifact.'],
      tsconfigPath,
    })
    expect(stderr).toBe('')
    const records = stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const delegatedWith = new Set<string>()
    let toolSchemaModel: unknown
    for (const record of records) {
      if (record['type'] !== 'session_event') continue
      const event = record['event'] as {
        type: string
        data?: {
          name?: string
          arguments?: string
          header?: { tools?: Array<{ name?: string; parameters?: { properties?: Record<string, unknown> } }> }
        }
      }
      if (event.type === 'tool/call' && event.data?.name === 'subagent') {
        // The main agent chose the child's executor model at call time.
        delegatedWith.add(String((JSON.parse(event.data.arguments ?? '{}') as { model?: string }).model))
      }
      if (event.type === 'request/header') {
        for (const tool of event.data?.header?.tools ?? []) {
          if (tool.name === 'subagent') toolSchemaModel = tool.parameters?.properties?.['model']
        }
      }
    }
    // The `subagent` tool in the assembled app exposes the per-call model enum.
    expect(toolSchemaModel).toMatchObject({ type: 'string', enum: ['orchestration-child'] })
    // The main agent actually chose that model in the delegation call.
    expect(delegatedWith.has('orchestration-child')).toBe(true)

    const result = records.at(-1)
    expect(result).toMatchObject({ type: 'result' })
    const output = String(result?.['output'])
    expect(output).toContain('CHILD_RESULT')
    expect(output).toContain('PARENT_DONE')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
