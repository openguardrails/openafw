import { describe, expect, it } from 'vitest'
import {
  type ModelEntry,
  type ModelRegistry,
  type ProviderEntry,
  findModel,
  findProvider,
  isVision,
  normalizeModelRegistry,
  resolveApi,
} from './model-registry.ts'

const provider: ProviderEntry = {
  id: 'openclaw/anthropic',
  label: 'OpenClaw',
  baseUrl: 'https://api.example.com',
  api: 'anthropic-messages',
  auth: { kind: 'passthrough' },
  origin: 'seeded',
  seededFrom: 'openclaw/anthropic',
}

const model: ModelEntry = {
  id: 'gpt-5.5',
  providerId: 'openclaw/anthropic',
  label: 'GPT 5.5',
  input: ['text', 'image'],
  origin: 'manual',
}

describe('normalizeModelRegistry', () => {
  it('round-trips a valid registry', () => {
    const reg = { version: 3, providers: [provider], models: [model], combos: [] }
    expect(normalizeModelRegistry(reg)).toEqual(reg)
  })

  it('migrates a v1 registry forward (adds combos)', () => {
    const out = normalizeModelRegistry({ version: 1, providers: [provider], models: [model] })
    expect(out.version).toBe(3)
    expect(out.combos).toEqual([])
  })

  it('normalizes a fusion combo (panel + per-member failover + combo-level vision/web_search)', () => {
    const out = normalizeModelRegistry({
      version: 3,
      providers: [provider],
      models: [model],
      combos: [
        {
          id: 'c1',
          label: 'panel',
          panel: [
            { modelId: 'gpt-5.5' },
            {
              modelId: 'coder-x',
              switchOn: [
                { kind: 'tokens', tokenLimit: 1_000_000, period: 'day' },
                { kind: 'error' },
              ],
              fallback: { modelId: 'gpt-5.5' },
            },
          ],
          vision: { modelId: 'vision-mini' },
          webSearch: { providerId: 'ddg' },
          judge: { modelId: 'judge-x' },
          synthesizer: { modelId: 'gpt-5.5' },
        },
        { id: 'empty', label: 'no panel', panel: [] }, // dropped — no panel
      ],
    })
    expect(out.combos).toHaveLength(1)
    expect(out.combos[0]).toEqual({
      id: 'c1',
      label: 'panel',
      panel: [
        { modelId: 'gpt-5.5' },
        {
          modelId: 'coder-x',
          switchOn: [{ kind: 'tokens', tokenLimit: 1_000_000, period: 'day' }, { kind: 'error' }],
          fallback: { modelId: 'gpt-5.5' },
        },
      ],
      vision: { modelId: 'vision-mini' },
      webSearch: { providerId: 'ddg' },
      judge: { modelId: 'judge-x' },
      synthesizer: { modelId: 'gpt-5.5' },
      origin: 'manual',
    })
  })

  it('normalizes a combo cheapModel (for subagent/cron tasks)', () => {
    const out = normalizeModelRegistry({
      version: 3,
      providers: [provider],
      models: [model],
      combos: [
        {
          id: 'c1',
          label: 'panel',
          panel: [{ modelId: 'gpt-5.5' }],
          cheapModel: { modelId: 'mini', providerId: 'op' },
        },
      ],
    })
    expect(out.combos[0]?.cheapModel).toEqual({ modelId: 'mini', providerId: 'op' })
  })

  it('drops a malformed cheapModel but keeps the combo', () => {
    const out = normalizeModelRegistry({
      version: 3,
      providers: [provider],
      models: [model],
      combos: [
        {
          id: 'c1',
          label: 'panel',
          panel: [{ modelId: 'gpt-5.5' }],
          cheapModel: { providerId: 'op' },
        },
      ],
    })
    expect(out.combos).toHaveLength(1)
    expect(out.combos[0]?.cheapModel).toBeUndefined()
  })

  it('migrates a legacy failover combo to a fusion panel, lifting capabilities to the combo level', () => {
    const out = normalizeModelRegistry({
      version: 2,
      providers: [provider],
      models: [model],
      combos: [
        {
          id: 'c1',
          label: 'legacy',
          members: [{ modelId: 'gpt-5.5', switchOn: [{ kind: 'error' }] }, { modelId: 'claude-x' }],
          capabilities: {
            vision: { via: 'companion', modelId: 'vision-mini' },
            web_search: { via: 'local', providerId: 'ddg' },
          },
        },
      ],
    })
    expect(out.combos[0]).toEqual({
      id: 'c1',
      label: 'legacy',
      panel: [{ modelId: 'gpt-5.5', switchOn: [{ kind: 'error' }] }, { modelId: 'claude-x' }],
      vision: { modelId: 'vision-mini' },
      webSearch: { providerId: 'ddg' },
      origin: 'manual',
    })
  })

  it('returns an empty registry for non-object input', () => {
    expect(normalizeModelRegistry(null).providers).toEqual([])
    expect(normalizeModelRegistry('nope').models).toEqual([])
  })

  it('throws on an unsupported version', () => {
    expect(() =>
      normalizeModelRegistry({ version: 9, providers: [], models: [], combos: [] }),
    ).toThrow()
  })

  it('drops malformed providers but keeps valid ones', () => {
    const reg = normalizeModelRegistry({
      version: 1,
      providers: [
        provider,
        { id: 'bad', baseUrl: '', api: 'anthropic-messages', auth: { kind: 'passthrough' } },
        { id: 'bad2', baseUrl: 'x', api: 'not-an-api', auth: { kind: 'passthrough' } },
      ],
      models: [],
    })
    expect(reg.providers).toHaveLength(1)
    expect(reg.providers[0]?.id).toBe('openclaw/anthropic')
  })

  it('rejects an api-key auth missing its header', () => {
    const reg = normalizeModelRegistry({
      version: 1,
      providers: [{ ...provider, auth: { kind: 'api-key', valueRef: 'k' } }],
      models: [],
    })
    expect(reg.providers).toHaveLength(0)
  })

  it('defaults a model with no modality to text-only', () => {
    const reg = normalizeModelRegistry({
      version: 1,
      providers: [provider],
      models: [{ id: 'm', providerId: 'p', label: 'M' }],
    })
    expect(reg.models[0]?.input).toEqual(['text'])
  })

  it('keeps cost only when both input and output are numbers', () => {
    const reg = normalizeModelRegistry({
      version: 1,
      providers: [provider],
      models: [
        { id: 'a', providerId: 'p', label: 'A', input: ['text'], cost: { input: 1, output: 2 } },
        { id: 'b', providerId: 'p', label: 'B', input: ['text'], cost: { input: 1 } },
      ],
    })
    expect(reg.models[0]?.cost).toEqual({ input: 1, output: 2 })
    expect(reg.models[1]?.cost).toBeUndefined()
  })

  it('preserves provider generation paths and model reasoning effort overrides', () => {
    const reg = normalizeModelRegistry({
      version: 3,
      providers: [
        {
          ...provider,
          api: 'openai-responses',
          generationPath: 'direct',
          reasoningEffort: 'high',
        },
      ],
      models: [{ ...model, reasoningEffort: 'xhigh' }],
      combos: [],
    })

    expect(reg.providers[0]?.generationPath).toBe('direct')
    expect(reg.providers[0]?.reasoningEffort).toBe('high')
    expect(reg.models[0]?.reasoningEffort).toBe('xhigh')
  })

  it('loads a named tool-call parser dialect', () => {
    const reg = normalizeModelRegistry({
      version: 3,
      providers: [{ ...provider, toolCallParser: 'glm' }],
      models: [model],
      combos: [],
    })
    expect(reg.providers[0]?.toolCallParser).toBe('glm')
  })

  it('maps the legacy xmlToolCalls boolean to the glm parser', () => {
    const reg = normalizeModelRegistry({
      version: 3,
      providers: [{ ...provider, xmlToolCalls: true }],
      models: [model],
      combos: [],
    })
    expect(reg.providers[0]?.toolCallParser).toBe('glm')
  })

  it('ignores an unknown tool-call parser', () => {
    const reg = normalizeModelRegistry({
      version: 3,
      providers: [{ ...provider, toolCallParser: 'nonsense' }],
      models: [model],
      combos: [],
    })
    expect(reg.providers[0]?.toolCallParser).toBeUndefined()
  })
})

describe('registry helpers', () => {
  const reg: ModelRegistry = { version: 3, providers: [provider], models: [model], combos: [] }

  it('finds providers and models by id', () => {
    expect(findProvider(reg, 'openclaw/anthropic')?.label).toBe('OpenClaw')
    expect(findModel(reg, 'gpt-5.5')?.label).toBe('GPT 5.5')
    expect(findModel(reg, 'missing')).toBeUndefined()
  })

  it('resolves a model api from its own override then the provider', () => {
    expect(resolveApi(reg, model)).toBe('anthropic-messages')
    expect(resolveApi(reg, { ...model, api: 'openai-chat' })).toBe('openai-chat')
    expect(resolveApi(reg, { ...model, providerId: 'gone' })).toBeUndefined()
  })

  it('flags vision models by the image modality', () => {
    expect(isVision(model)).toBe(true)
    expect(isVision({ ...model, input: ['text'] })).toBe(false)
  })
})
