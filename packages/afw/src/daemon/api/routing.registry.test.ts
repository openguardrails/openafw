import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { state, setSecret } = vi.hoisted(() => ({
  state: {
    reg: {
      version: 3,
      providers: [] as Array<Record<string, unknown>>,
      models: [] as Array<Record<string, unknown>>,
      combos: [] as Array<Record<string, unknown>>,
    },
  },
  setSecret: vi.fn(),
}))

vi.mock('../../core/model-registry.ts', () => ({
  MODEL_REGISTRY_VERSION: 3,
  EMPTY_REGISTRY: { version: 3, providers: [], models: [], combos: [] },
  MAX_FUSION_PANEL: 8,
  REASONING_EFFORTS: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  GENERATION_PATH_MODES: ['versioned', 'direct'],
  TOOL_CALL_PARSERS: ['glm'],
  findProvider: (reg: typeof state.reg, id: string) => reg.providers.find((p) => p.id === id),
  findModel: (reg: typeof state.reg, id: string, providerId?: string) =>
    reg.models.find(
      (m) => m.id === id && (providerId === undefined || m.providerId === providerId),
    ),
  findCombo: (reg: typeof state.reg, id: string) => reg.combos.find((c) => c.id === id),
  mutateModelRegistry: async (fn: (reg: typeof state.reg) => typeof state.reg | undefined) => {
    const next = fn(state.reg)
    if (next) state.reg = next
    return state.reg
  },
  readModelRegistry: async () => state.reg,
}))

vi.mock('../../core/routing-policy.ts', () => ({
  effectiveSubagentDowngrade: vi.fn(),
  mutateRoutingPolicy: vi.fn(),
  readRoutingPolicy: vi.fn(),
}))

vi.mock('../../core/secrets.ts', () => ({
  getSecret: vi.fn(),
  readSecrets: vi.fn(async () => ({})),
  removeSecret: vi.fn(),
  secretRefs: vi.fn(() => []),
  setSecret,
}))

vi.mock('../../cli/backup/manifest.ts', () => ({ readManifest: vi.fn() }))
vi.mock('../../core/tool-providers.ts', () => ({
  activeProviderFor: vi.fn(),
  readToolProviders: vi.fn(),
}))
vi.mock('../orchestrator/budget.ts', () => ({ clearBudgetCache: vi.fn() }))
vi.mock('../routes/load.ts', () => ({ getRoutes: vi.fn() }))
vi.mock('../store/models-queries.ts', () => ({
  baselineInputTokens: vi.fn(),
  recentModels: vi.fn(),
}))

const { handlePostModel, handlePostProvider, handlePostProviderEffort } = await import(
  './routing.ts'
)

function jsonContext(body: Record<string, unknown>): Context {
  return {
    req: { json: vi.fn(async () => body) },
    json: (payload: unknown, status?: number) => Response.json(payload, { status: status ?? 200 }),
  } as unknown as Context
}

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

describe('routing registry writes', () => {
  beforeEach(() => {
    state.reg = { version: 3, providers: [], models: [], combos: [] }
    setSecret.mockReset()
  })

  it('stores direct generation paths and case-insensitive provider reasoning effort', async () => {
    const res = await handlePostProvider(
      jsonContext({
        id: 'w-ciykj-cn',
        label: 'w-ciykj-cn',
        baseUrl: 'https://w.ciykj.cn',
        api: 'openai-responses',
        authKind: 'passthrough',
        generationPath: 'Direct',
        reasoningEffort: 'XHigh',
      }),
    )

    expect(res.status).toBe(200)
    const json = await responseJson(res)
    expect(json.providers).toEqual([
      {
        id: 'w-ciykj-cn',
        label: 'w-ciykj-cn',
        baseUrl: 'https://w.ciykj.cn',
        api: 'openai-responses',
        auth: { kind: 'passthrough' },
        origin: 'manual',
        generationPath: 'direct',
        reasoningEffort: 'xhigh',
      },
    ])
  })

  it('rejects invalid provider generation paths', async () => {
    const res = await handlePostProvider(
      jsonContext({
        id: 'bad',
        baseUrl: 'https://api.example.com',
        api: 'openai-responses',
        authKind: 'passthrough',
        generationPath: 'bare',
      }),
    )

    expect(res.status).toBe(400)
    await expect(responseJson(res)).resolves.toMatchObject({
      error: 'generationPath must be one of versioned, direct',
    })
  })

  it('updates provider effort case-insensitively without replacing the provider', async () => {
    state.reg.providers = [
      {
        id: 'w-ciykj-cn',
        label: 'w-ciykj-cn',
        baseUrl: 'https://w.ciykj.cn',
        api: 'openai-responses',
        auth: { kind: 'bearer', valueRef: 'provider:w-ciykj-cn' },
        origin: 'manual',
        generationPath: 'direct',
      },
    ]

    const res = await handlePostProviderEffort(
      jsonContext({ id: 'w-ciykj-cn', reasoningEffort: 'LOW' }),
    )

    expect(res.status).toBe(200)
    expect(state.reg.providers[0]).toMatchObject({
      id: 'w-ciykj-cn',
      generationPath: 'direct',
      reasoningEffort: 'low',
    })
  })

  it('stores case-insensitive model reasoning effort overrides', async () => {
    state.reg.providers = [
      {
        id: 'w-ciykj-cn',
        label: 'w-ciykj-cn',
        baseUrl: 'https://w.ciykj.cn',
        api: 'openai-responses',
        auth: { kind: 'passthrough' },
        origin: 'manual',
      },
    ]

    const res = await handlePostModel(
      jsonContext({
        id: 'GPT-5.5',
        providerId: 'w-ciykj-cn',
        label: 'GPT-5.5',
        input: ['text'],
        reasoningEffort: 'High',
      }),
    )

    expect(res.status).toBe(200)
    expect(state.reg.models[0]).toMatchObject({
      id: 'GPT-5.5',
      providerId: 'w-ciykj-cn',
      reasoningEffort: 'high',
    })
  })

  it('rewrites fusion references when a model wire id is renamed', async () => {
    state.reg.providers = [
      {
        id: 'w-ciykj-cn',
        label: 'w-ciykj-cn',
        baseUrl: 'https://w.ciykj.cn',
        api: 'openai-responses',
        auth: { kind: 'passthrough' },
        origin: 'manual',
      },
      {
        id: 'backup',
        label: 'backup',
        baseUrl: 'https://backup.example',
        api: 'openai-responses',
        auth: { kind: 'passthrough' },
        origin: 'manual',
      },
    ]
    state.reg.models = [
      {
        id: 'GPT-5.5',
        providerId: 'w-ciykj-cn',
        label: 'GPT-5.5',
        input: ['text'],
        origin: 'manual',
      },
      {
        id: 'gpt-5.5',
        providerId: 'backup',
        label: 'gpt-5.5',
        input: ['text'],
        origin: 'manual',
      },
    ]
    state.reg.combos = [
      {
        id: 'gpt-claude',
        label: 'gpt+claude',
        panel: [
          {
            modelId: 'GPT-5.5',
            providerId: 'w-ciykj-cn',
            fallback: { modelId: 'gpt-5.5', providerId: 'backup' },
          },
          {
            modelId: 'other',
            providerId: 'backup',
            fallback: { modelId: 'GPT-5.5', providerId: 'w-ciykj-cn' },
          },
        ],
        judge: { modelId: 'GPT-5.5', providerId: 'w-ciykj-cn' },
        synthesizer: { modelId: 'GPT-5.5', providerId: 'w-ciykj-cn' },
        origin: 'manual',
      },
    ]

    const res = await handlePostModel(
      jsonContext({
        previousId: 'GPT-5.5',
        id: 'gpt-5.5',
        providerId: 'w-ciykj-cn',
        input: ['text'],
      }),
    )

    expect(res.status).toBe(200)
    expect(state.reg.models).toContainEqual(
      expect.objectContaining({ id: 'gpt-5.5', providerId: 'w-ciykj-cn' }),
    )
    expect(state.reg.models).not.toContainEqual(
      expect.objectContaining({ id: 'GPT-5.5', providerId: 'w-ciykj-cn' }),
    )
    expect(state.reg.models).toContainEqual(
      expect.objectContaining({ id: 'gpt-5.5', providerId: 'backup' }),
    )
    expect(state.reg.combos[0]).toMatchObject({
      panel: [
        {
          modelId: 'gpt-5.5',
          providerId: 'w-ciykj-cn',
          fallback: { modelId: 'gpt-5.5', providerId: 'backup' },
        },
        {
          modelId: 'other',
          providerId: 'backup',
          fallback: { modelId: 'gpt-5.5', providerId: 'w-ciykj-cn' },
        },
      ],
      judge: { modelId: 'gpt-5.5', providerId: 'w-ciykj-cn' },
      synthesizer: { modelId: 'gpt-5.5', providerId: 'w-ciykj-cn' },
    })
  })
})
