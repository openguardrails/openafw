// The model registry — ~/.afw/models.json. The catalog of providers and
// models afw can route an agent to. Seeded automatically from the wire
// (one provider per route, models observed in captured traffic) and extended
// by the user. Modeled on OpenClaw's provider/model onboarding config.

import { readFile } from 'node:fs/promises'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { paths } from './paths.ts'
import {
  type CapabilityFulfillment,
  type CapabilityId,
  type ChainMember,
  type SwitchRule,
  normalizeCapabilities,
  normalizeMember,
} from './routing-policy.ts'

export const MODEL_REGISTRY_VERSION = 3 as const

/** The three request/response wire formats afw can translate between. */
export type ModelApi = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

export type Modality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

/** Reasoning effort knob shared across OpenAI Responses (`reasoning.effort`)
 *  and Anthropic Messages (thinking budget). */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** How to append generation endpoints to a provider's base URL.
 *
 *  - `versioned` is the OpenAI/Anthropic SDK convention: add `/v1` when the
 *    base URL does not already end with it.
 *  - `direct` appends the endpoint directly to the base. Some gateways expose
 *    Responses as `/responses` rather than `/v1/responses`. */
export type GenerationPathMode = 'versioned' | 'direct'

/** Dialect for tool calls a provider emits as inline text in the assistant
 *  message instead of native structured `tool_calls` / `function_call` items.
 *  afw's analog of vLLM's `--tool-call-parser`: it tells afw which in-content
 *  format to parse and promote, and forces the buffered route (an inline call
 *  can't be reconstructed from live SSE deltas).
 *
 *  - `glm` — GLM-4.5/4.6/5.x served with vLLM `--tool-call-parser glm47`
 *    (or an endpoint that leaks that format): `<tool_call>name<arg_key>k
 *    </arg_key><arg_value>v</arg_value>…</tool_call>`. Also covers the
 *    Hermes/Qwen JSON-in-`<tool_call>` and Claude `<invoke>` shapes, which
 *    the same parser recognizes. */
export type ToolCallParser = 'glm'

export const TOOL_CALL_PARSERS: readonly ToolCallParser[] = ['glm'] as const

export type ProviderAuth =
  // Inject a custom header (e.g. `x-api-key`) with a value from secrets.json.
  | { kind: 'api-key'; header: string; valueRef: string }
  // Inject `Authorization: Bearer <secret>`.
  | { kind: 'bearer'; valueRef: string }
  // Inject a subscription OAuth token afw reads — and refreshes — from afw's
  // OWN OAuth store (~/.afw/oauth/), populated by `afw oauth login`. afw never
  // reads the agent's own credential store, and the token is never copied into
  // secrets.json.
  | { kind: 'agent-oauth'; agent: 'claude-code' | 'codex' }
  // Reuse the client agent's own auth header verbatim (same-provider routing).
  | { kind: 'passthrough' }

export type ProviderEntry = {
  id: string
  label: string
  baseUrl: string
  api: ModelApi
  auth: ProviderAuth
  origin: 'seeded' | 'manual'
  /** For seeded providers — the routeKey "<agent>/<provider>" they came from. */
  seededFrom?: string
  /** Reasoning effort applied to requests this provider sees. For OAuth
   *  subscriptions this is load-bearing (codex's chatgpt backend returns
   *  empty content without `reasoning.effort`, claude-code thinking is
   *  set from this); for api-key providers it's an optional default a
   *  routed call can carry to a reasoning-capable model. */
  reasoningEffort?: ReasoningEffort
  /** Optional endpoint path mode for gateways that do not use `/v1`. */
  generationPath?: GenerationPathMode
  /** Set when this provider's model emits tool calls as inline text (e.g. a
   *  GLM/vLLM endpoint that leaks the `glm47` format) instead of native
   *  structured calls. Names the dialect to parse — afw's `--tool-call-parser`.
   *  Forces the buffered route so the response is parsed and the inline call
   *  promoted to a real tool call; a same-protocol stream would relay the raw
   *  text and the agent would stop instead of running the tool. */
  toolCallParser?: ToolCallParser
}

/** USD per million tokens, the display convention used across afw. */
export type ModelCost = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export type ModelEntry = {
  id: string
  providerId: string
  label: string
  /** Overrides the provider's api when a provider hosts mixed wire formats. */
  api?: ModelApi
  /** The modality array doubles as the vision flag — see isVision(). */
  input: Modality[]
  contextWindow?: number
  maxTokens?: number
  /** Optional model-level override for provider.reasoningEffort. */
  reasoningEffort?: ReasoningEffort
  cost?: ModelCost
  origin: 'seeded' | 'manual'
}

/** A model endpoint reference inside a fusion combo — the judge and the
 *  synthesizer. `providerId` disambiguates when the id exists under more than
 *  one provider. */
export type FusionEndpoint = {
  modelId: string
  providerId?: string
}

/** One panel member of a fusion combination model — a model that answers the
 *  prompt in parallel with the rest of the panel, with its own per-member
 *  failover.
 *
 *  - `switchOn`: when to fail this member over to its `fallback` — a daily/monthly
 *    token or USD cap, and/or on upstream error (e.g. a provider's 5-hour rate
 *    limit). Empty/absent → no failover.
 *  - `fallback`: the backup model used when a `switchOn` rule fires. Resolves to
 *    a 2-member chain `[primary{switchOn}, fallback]` per panel slot.
 *
 *  Vision (the text↔multimodal bridge) and web_search are configured once at the
 *  combo level (see CombinationModel), not per member — one designated companion
 *  serves every text-only panel member. */
export type FusionMember = {
  modelId: string
  providerId?: string
  switchOn?: SwitchRule[]
  fallback?: FusionEndpoint
}

/** A reusable combination model — afw's local take on OpenRouter Fusion. A
 *  panel of models answers the prompt in parallel, a judge distils their answers
 *  into a structured analysis (consensus / contradictions / unique insights /
 *  blind spots), and a synthesizer writes the single best final answer grounded
 *  in it. Routes target a combo by id (`{kind:'composite', comboId}`); the combo
 *  — not the route — is the source of truth for its panel.
 *
 *  - `vision`: ONE multimodal companion for the whole fusion. When the prompt
 *    carries images, afw pre-describes them via this model so any text-only
 *    panel member can still take part. Omit it when the panel is already
 *    multimodal. (afw's edge over OpenRouter Fusion, which drops images for
 *    text-only panel members.)
 *  - `webSearch`: run web_search locally for the panel (anthropic client →
 *    non-anthropic upstream), pinned to a tool provider.
 *  - `judge` defaults to the synthesizer; `synthesizer` defaults to the first
 *    panel member — so a minimal combo is just a panel. */
export type CombinationModel = {
  id: string
  label: string
  /** 1–MAX_PANEL members, run in parallel. */
  panel: FusionMember[]
  vision?: FusionEndpoint
  webSearch?: { providerId?: string }
  judge?: FusionEndpoint
  synthesizer?: FusionEndpoint
  /** A single cheap model for the simple, high-volume tasks routed to this
   *  combo — Claude Code subagents and hermes/openclaw cron jobs. When a
   *  request is classified as one of those, it goes straight to this model and
   *  the panel/judge/synthesizer are skipped entirely (no fusion cost for work
   *  that doesn't need it). Absent → every request runs the full fusion. */
  cheapModel?: FusionEndpoint
  origin: 'manual'
}

/** OpenRouter Fusion caps its panel at 8 models; mirror that. */
export const MAX_FUSION_PANEL = 8

export type ModelRegistry = {
  version: typeof MODEL_REGISTRY_VERSION
  providers: ProviderEntry[]
  models: ModelEntry[]
  combos: CombinationModel[]
}

export const EMPTY_REGISTRY: ModelRegistry = {
  version: MODEL_REGISTRY_VERSION,
  providers: [],
  models: [],
  combos: [],
}

const MODEL_APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const MODALITIES: Modality[] = ['text', 'audio', 'image', 'video', 'pdf']
export const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']
export const GENERATION_PATH_MODES: GenerationPathMode[] = ['versioned', 'direct']

// ── helpers ───────────────────────────────────────────────────────

export function findProvider(reg: ModelRegistry, id: string): ProviderEntry | undefined {
  return reg.providers.find((p) => p.id === id)
}

/** Look up a model by id, optionally scoped to a provider.
 *
 *  Same model id can exist under multiple providers (e.g. a Xiangxin
 *  model harvested under `hermes/...` and also added by hand under a
 *  custom `og-text` provider). When `providerId` is supplied we match
 *  the exact pair; otherwise we fall back to the first matching id so
 *  legacy callers (and pre-providerId routing-policy entries) still
 *  resolve to *something* instead of breaking. */
export function findModel(
  reg: ModelRegistry,
  id: string,
  providerId?: string,
): ModelEntry | undefined {
  if (providerId !== undefined) {
    return reg.models.find((m) => m.id === id && m.providerId === providerId)
  }
  return reg.models.find((m) => m.id === id)
}

/** A model's effective wire format: its own override, else its provider's. */
export function resolveApi(reg: ModelRegistry, model: ModelEntry): ModelApi | undefined {
  return model.api ?? findProvider(reg, model.providerId)?.api
}

/** A model can see images — the trigger for the text↔multimodal split. */
export function isVision(model: ModelEntry): boolean {
  return model.input.includes('image')
}

export function findCombo(reg: ModelRegistry, id: string): CombinationModel | undefined {
  return reg.combos.find((c) => c.id === id)
}

// ── parse / normalize ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeAuth(raw: unknown): ProviderAuth | undefined {
  if (!isObj(raw)) return undefined
  if (raw.kind === 'passthrough') return { kind: 'passthrough' }
  if (raw.kind === 'agent-oauth' && (raw.agent === 'claude-code' || raw.agent === 'codex')) {
    return { kind: 'agent-oauth', agent: raw.agent }
  }
  if (raw.kind === 'bearer' && typeof raw.valueRef === 'string') {
    return { kind: 'bearer', valueRef: raw.valueRef }
  }
  if (
    raw.kind === 'api-key' &&
    typeof raw.header === 'string' &&
    raw.header !== '' &&
    typeof raw.valueRef === 'string'
  ) {
    return { kind: 'api-key', header: raw.header, valueRef: raw.valueRef }
  }
  return undefined
}

function normalizeProvider(raw: unknown): ProviderEntry | undefined {
  if (!isObj(raw)) return undefined
  const { id, label, baseUrl, api, origin, seededFrom, reasoningEffort, generationPath } = raw
  const rawObj = raw as Record<string, unknown>
  // Back-compat: the old boolean `xmlToolCalls: true` means the GLM dialect.
  const toolCallParser: ToolCallParser | undefined = TOOL_CALL_PARSERS.includes(
    rawObj.toolCallParser as ToolCallParser,
  )
    ? (rawObj.toolCallParser as ToolCallParser)
    : rawObj.xmlToolCalls === true
      ? 'glm'
      : undefined
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  if (!MODEL_APIS.includes(api as ModelApi)) return undefined
  const auth = normalizeAuth(raw.auth)
  if (!auth) return undefined
  return {
    id,
    label: typeof label === 'string' ? label : id,
    baseUrl,
    api: api as ModelApi,
    auth,
    origin: origin === 'manual' ? 'manual' : 'seeded',
    ...(typeof seededFrom === 'string' ? { seededFrom } : {}),
    ...(REASONING_EFFORTS.includes(reasoningEffort as ReasoningEffort)
      ? { reasoningEffort: reasoningEffort as ReasoningEffort }
      : {}),
    ...(GENERATION_PATH_MODES.includes(generationPath as GenerationPathMode)
      ? { generationPath: generationPath as GenerationPathMode }
      : {}),
    ...(toolCallParser ? { toolCallParser } : {}),
  }
}

function normalizeCost(raw: unknown): ModelCost | undefined {
  if (!isObj(raw)) return undefined
  const { input, output, cacheRead, cacheWrite } = raw
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  return {
    input,
    output,
    ...(typeof cacheRead === 'number' ? { cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cacheWrite } : {}),
  }
}

function normalizeModel(raw: unknown): ModelEntry | undefined {
  if (!isObj(raw)) return undefined
  const { id, providerId, label, api, origin, contextWindow, maxTokens, reasoningEffort } = raw
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof providerId !== 'string' || providerId === '') return undefined
  const input = Array.isArray(raw.input)
    ? raw.input.filter((m): m is Modality => MODALITIES.includes(m as Modality))
    : []
  const cost = normalizeCost(raw.cost)
  return {
    id,
    providerId,
    label: typeof label === 'string' ? label : id,
    ...(MODEL_APIS.includes(api as ModelApi) ? { api: api as ModelApi } : {}),
    input: input.length > 0 ? input : ['text'],
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
    ...(REASONING_EFFORTS.includes(reasoningEffort as ReasoningEffort)
      ? { reasoningEffort: reasoningEffort as ReasoningEffort }
      : {}),
    ...(cost ? { cost } : {}),
    origin: origin === 'manual' ? 'manual' : 'seeded',
  }
}

function normalizeFusionEndpoint(raw: unknown): FusionEndpoint | undefined {
  if (!isObj(raw)) return undefined
  if (typeof raw.modelId !== 'string' || raw.modelId === '') return undefined
  return {
    modelId: raw.modelId,
    ...(typeof raw.providerId === 'string' && raw.providerId !== ''
      ? { providerId: raw.providerId }
      : {}),
  }
}

function normalizeWebSearch(raw: unknown): { providerId?: string } | undefined {
  if (!isObj(raw)) return undefined
  return typeof raw.providerId === 'string' && raw.providerId !== ''
    ? { providerId: raw.providerId }
    : {}
}

/** A fusion panel member: the primary model, its per-member failover rules
 *  (`switchOn` — token/USD caps + error), and the `fallback` model they switch
 *  to. `normalizeMember` parses the {modelId, providerId, switchOn} part. */
function normalizeFusionMember(raw: unknown): FusionMember | undefined {
  const base = normalizeMember(raw)
  if (!base) return undefined
  const fallback = isObj(raw) ? normalizeFusionEndpoint(raw.fallback) : undefined
  return {
    modelId: base.modelId,
    ...(base.providerId ? { providerId: base.providerId } : {}),
    ...(base.switchOn ? { switchOn: base.switchOn } : {}),
    ...(fallback ? { fallback } : {}),
  }
}

/** Lift a legacy failover-combo's combo-level vision/web_search capabilities to
 *  the fusion's combo-level vision/web_search, so they survive the move from
 *  failover chains to fusion. */
function legacyCaps(rawCaps: unknown): {
  vision?: FusionEndpoint
  webSearch?: { providerId?: string }
} {
  const caps = normalizeCapabilities(rawCaps)
  const vision =
    caps?.vision?.via === 'companion'
      ? {
          modelId: caps.vision.modelId,
          ...(caps.vision.providerId ? { providerId: caps.vision.providerId } : {}),
        }
      : undefined
  const webSearch =
    caps?.web_search?.via === 'local'
      ? caps.web_search.providerId
        ? { providerId: caps.web_search.providerId }
        : {}
      : undefined
  return { ...(vision ? { vision } : {}), ...(webSearch ? { webSearch } : {}) }
}

/** A fusion combination model. Accepts the current `panel` shape and migrates
 *  the legacy failover-combo shape (`members` + `capabilities`) forward: each
 *  member becomes a panel member, and the old combo-level vision/web_search
 *  capabilities become the combo-level `vision`/`webSearch`. Dropped when it has
 *  no id or no resolvable panel member. */
function normalizeCombo(raw: unknown): CombinationModel | undefined {
  if (!isObj(raw)) return undefined
  const { id, label } = raw
  if (typeof id !== 'string' || id === '') return undefined

  let panel: FusionMember[]
  let migrated: { vision?: FusionEndpoint; webSearch?: { providerId?: string } } = {}
  if (Array.isArray(raw.panel)) {
    panel = raw.panel.map(normalizeFusionMember).filter((m): m is FusionMember => m != null)
  } else if (Array.isArray(raw.members)) {
    migrated = legacyCaps(raw.capabilities)
    panel = raw.members
      .map(normalizeMember)
      .filter((m): m is ChainMember => m != null)
      .map((m) => ({
        modelId: m.modelId,
        ...(m.providerId ? { providerId: m.providerId } : {}),
        ...(m.switchOn ? { switchOn: m.switchOn } : {}),
      }))
  } else {
    panel = []
  }
  if (panel.length === 0) return undefined

  const vision = normalizeFusionEndpoint(raw.vision) ?? migrated.vision
  const webSearch = normalizeWebSearch(raw.webSearch) ?? migrated.webSearch
  const judge = normalizeFusionEndpoint(raw.judge)
  const synthesizer = normalizeFusionEndpoint(raw.synthesizer)
  const cheapModel = normalizeFusionEndpoint(raw.cheapModel)
  return {
    id,
    label: typeof label === 'string' && label !== '' ? label : id,
    panel: panel.slice(0, MAX_FUSION_PANEL),
    ...(vision ? { vision } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(judge ? { judge } : {}),
    ...(synthesizer ? { synthesizer } : {}),
    ...(cheapModel ? { cheapModel } : {}),
    origin: 'manual',
  }
}

/** Coerce parsed JSON into a valid registry — malformed entries are dropped,
 *  a hand-edited file with one bad entry never wipes the rest. v1 (no `combos`)
 *  and v2 (failover-style combos) are accepted and migrated forward by
 *  `normalizeCombo` — v2 combos' `members`/`capabilities` become a fusion
 *  `panel`. Throws only on an unsupported version, so a future format is never
 *  silently downgraded. */
export function normalizeModelRegistry(raw: unknown): ModelRegistry {
  if (!isObj(raw)) return { ...EMPTY_REGISTRY }
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== MODEL_REGISTRY_VERSION) {
    throw new Error(
      `models.json version ${String(raw.version)} not supported (expected ${MODEL_REGISTRY_VERSION})`,
    )
  }
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map(normalizeProvider).filter((p): p is ProviderEntry => p != null)
    : []
  const models = Array.isArray(raw.models)
    ? raw.models.map(normalizeModel).filter((m): m is ModelEntry => m != null)
    : []
  const combos = Array.isArray(raw.combos)
    ? raw.combos.map(normalizeCombo).filter((c): c is CombinationModel => c != null)
    : []
  return { version: MODEL_REGISTRY_VERSION, providers, models, combos }
}

// ── read / write ──────────────────────────────────────────────────

export async function readModelRegistry(): Promise<ModelRegistry> {
  if (!(await fileExists(paths.models))) return { ...EMPTY_REGISTRY }
  return normalizeModelRegistry(JSON.parse(await readFile(paths.models, 'utf8')))
}

export async function writeModelRegistry(reg: ModelRegistry): Promise<void> {
  await atomicWrite(paths.models, `${JSON.stringify(reg, null, 2)}\n`)
}

// why: read-modify-write of one shared file races under concurrency (the
// observed-model hook fires on every model_call). Serialize all mutations
// through one chain so no update is lost.
let writeChain: Promise<unknown> = Promise.resolve()

export function mutateModelRegistry(
  fn: (reg: ModelRegistry) => ModelRegistry | undefined,
): Promise<ModelRegistry> {
  const next = writeChain.then(async () => {
    const reg = await readModelRegistry()
    const updated = fn(reg)
    if (updated) await writeModelRegistry(updated)
    return updated ?? reg
  })
  writeChain = next.catch(() => {})
  return next
}
