// /api/routing — the daemon side of the Control · Routing UI and the
// `afw route` CLI. Reads and mutates the three routing config files
// (models.json, routing.json, secrets.json) and reports last-24h spend.
//
// Secrets are write-only across this surface: the UI sends API-key values
// in, but only ever gets back the set of refs that exist — never a value.

import type { Context } from 'hono'
import { readManifest } from '../../cli/backup/manifest.ts'
import { upsertRoutes } from '../../cli/wire/routes.ts'
import { logger } from '../../core/logger.ts'
import {
  type CombinationModel,
  type FusionEndpoint,
  type FusionMember,
  GENERATION_PATH_MODES,
  type GenerationPathMode,
  MAX_FUSION_PANEL,
  type Modality,
  type ModelApi,
  type ModelCost,
  type ModelEntry,
  type ProviderAuth,
  type ProviderEntry,
  REASONING_EFFORTS,
  type ReasoningEffort,
  TOOL_CALL_PARSERS,
  type ToolCallParser,
  findCombo,
  findModel,
  findProvider,
  mutateModelRegistry,
  readModelRegistry,
} from '../../core/model-registry.ts'
import {
  type ChainMember,
  type RoutingTarget,
  type SwitchRule,
  effectiveSubagentDowngrade,
  mutateRoutingPolicy,
  normalizeSwitchRule,
  readRoutingPolicy,
} from '../../core/routing-policy.ts'
import { getSecret, readSecrets, removeSecret, secretRefs, setSecret } from '../../core/secrets.ts'
import { type ToolKind, activeProviderFor, readToolProviders } from '../../core/tool-providers.ts'
import { clearBudgetCache } from '../orchestrator/budget.ts'
import { getRoutes } from '../routes/load.ts'
import { baselineInputTokens, recentModels } from '../store/models-queries.ts'

const MODEL_APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const MODALITIES: Modality[] = ['text', 'audio', 'image', 'video', 'pdf']
const ONE_DAY = 24 * 3_600_000

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json()
    return isObj(body) ? body : null
  } catch {
    return null
  }
}

function normalizeReasoningEffort(raw: unknown): ReasoningEffort | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined
}

function normalizeGenerationPath(raw: unknown): GenerationPathMode | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  return GENERATION_PATH_MODES.includes(value as GenerationPathMode)
    ? (value as GenerationPathMode)
    : undefined
}

// ── GET /api/routing/registry ─────────────────────────────────────

export async function handleGetRegistry(c: Context): Promise<Response> {
  const reg = await readModelRegistry()
  const secrets = await readSecrets()
  return c.json({
    providers: reg.providers,
    models: reg.models,
    combos: reg.combos,
    secretRefs: secretRefs(secrets),
  })
}

// ── POST /api/routing/provider ────────────────────────────────────

/** Derive a stable, URL-safe internal id from a human name. Falls back to
 *  `provider` for names with no ASCII alphanumerics (e.g. pure CJK), and
 *  suffixes `-2`, `-3`, … to avoid colliding with an existing id. The id is
 *  what routing.json chains and the `provider:<id>` secret ref point at, so it
 *  is generated once at creation and never changes — the user only ever edits
 *  the display name. */
function deriveId(name: string, taken: Iterable<string>, fallback: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || fallback
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!set.has(candidate)) return candidate
  }
}

function generateProviderId(name: string, taken: Iterable<string>): string {
  return deriveId(name, taken, 'provider')
}

export async function handlePostProvider(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  // The user types a display name; the id is internal. On edit the client
  // echoes back the existing id (so the upsert + secret ref stay keyed to it);
  // on create the id is absent and we derive a stable one from the name.
  const name =
    typeof body.name === 'string' && body.name.trim() !== ''
      ? body.name.trim()
      : typeof body.label === 'string'
        ? body.label.trim()
        : ''
  const providedId = typeof body.id === 'string' ? body.id.trim() : ''
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const api = body.api
  if (!providedId && !name) return c.json({ error: 'provider name required' }, 400)
  if (!baseUrl) return c.json({ error: 'baseUrl required' }, 400)
  if (!MODEL_APIS.includes(api as ModelApi)) {
    return c.json({ error: `api must be one of ${MODEL_APIS.join(', ')}` }, 400)
  }
  const reasoningEffort = normalizeReasoningEffort(body.reasoningEffort)
  if (body.reasoningEffort != null && !reasoningEffort) {
    return c.json({ error: `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}` }, 400)
  }
  const generationPath = normalizeGenerationPath(body.generationPath)
  if (body.generationPath != null && !generationPath) {
    return c.json(
      { error: `generationPath must be one of ${GENERATION_PATH_MODES.join(', ')}` },
      400,
    )
  }

  const reg0 = await readModelRegistry()
  const id =
    providedId ||
    generateProviderId(
      name,
      reg0.providers.map((p) => p.id),
    )
  // On edit the name may be omitted (id echoed back) — keep the existing label.
  const label = name || reg0.providers.find((p) => p.id === id)?.label || id

  const authKind = body.authKind
  let auth: ProviderAuth
  if (authKind === 'passthrough') {
    auth = { kind: 'passthrough' }
  } else if (authKind === 'agent-oauth') {
    // afw-owned subscription login: the token lives in afw's own OAuth store
    // (~/.afw/oauth/), refreshed at request time. No secret to persist here.
    const agent = body.agent
    if (agent !== 'claude-code' && agent !== 'codex') {
      return c.json({ error: 'agent-oauth requires agent "claude-code" or "codex"' }, 400)
    }
    auth = { kind: 'agent-oauth', agent }
  } else if (authKind === 'bearer' || authKind === 'api-key') {
    const valueRef = `provider:${id}`
    // why: only persist the key when the form actually carried one — editing
    // a provider without re-typing the key must keep the stored secret.
    if (typeof body.apiKey === 'string' && body.apiKey !== '') {
      await setSecret(valueRef, body.apiKey)
    }
    if (authKind === 'bearer') {
      auth = { kind: 'bearer', valueRef }
    } else {
      const header = typeof body.authHeader === 'string' ? body.authHeader.trim() : ''
      if (!header) return c.json({ error: 'authHeader required for api-key auth' }, 400)
      auth = { kind: 'api-key', header, valueRef }
    }
  } else {
    return c.json({ error: 'authKind must be passthrough, agent-oauth, bearer, or api-key' }, 400)
  }

  const provider: ProviderEntry = {
    id,
    label,
    baseUrl,
    api: api as ModelApi,
    auth,
    origin: 'manual',
    ...(generationPath ? { generationPath } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(TOOL_CALL_PARSERS.includes(body.toolCallParser as ToolCallParser)
      ? { toolCallParser: body.toolCallParser as ToolCallParser }
      : body.xmlToolCalls === true
        ? { toolCallParser: 'glm' as const }
        : {}),
  }

  const reg = await mutateModelRegistry((r) => ({
    ...r,
    providers: [...r.providers.filter((p) => p.id !== id), provider],
  }))
  return c.json({ ok: true, providers: reg.providers })
}

// ── POST /api/routing/provider/effort ─────────────────────────────

/** Update only the reasoningEffort field on a provider, preserving every
 *  other field (auth, origin, baseUrl). The user can flip this on seeded
 *  OAuth-subscription providers without converting them to `manual`. */
export async function handlePostProviderEffort(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return c.json({ error: 'provider id required' }, 400)
  const raw = body.reasoningEffort
  const effort = raw == null ? undefined : normalizeReasoningEffort(raw)
  if (raw != null && !effort) {
    return c.json(
      { error: `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')} or null` },
      400,
    )
  }
  const reg = await mutateModelRegistry((r) => ({
    ...r,
    providers: r.providers.map((p) => {
      if (p.id !== id) return p
      const next: ProviderEntry = { ...p }
      if (effort) next.reasoningEffort = effort
      else next.reasoningEffort = undefined
      return next
    }),
  }))
  return c.json({ ok: true, providers: reg.providers })
}

// ── DELETE /api/routing/provider?id= ──────────────────────────────

export async function handleDeleteProvider(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)

  const reg = await mutateModelRegistry((r) => ({
    ...r,
    // Drop the provider and any models that pointed at it — an orphan model
    // can never resolve.
    providers: r.providers.filter((p) => p.id !== id),
    models: r.models.filter((m) => m.providerId !== id),
  }))
  await removeSecret(`provider:${id}`)
  return c.json({ ok: true, providers: reg.providers, models: reg.models })
}

// ── POST /api/routing/model ───────────────────────────────────────

function normalizeModalities(raw: unknown): Modality[] {
  if (!Array.isArray(raw)) return ['text']
  const out = raw.filter((m): m is Modality => MODALITIES.includes(m as Modality))
  return out.length > 0 ? out : ['text']
}

function normalizeCostInput(raw: unknown): ModelCost | undefined {
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

function rewriteFusionEndpoint(
  endpoint: FusionEndpoint | undefined,
  fromModelId: string,
  toModelId: string,
  providerId: string,
): FusionEndpoint | undefined {
  if (!endpoint) return undefined
  if (endpoint.modelId !== fromModelId || endpoint.providerId !== providerId) return endpoint
  return { ...endpoint, modelId: toModelId }
}

function rewriteFusionMember(
  member: FusionMember,
  fromModelId: string,
  toModelId: string,
  providerId: string,
): FusionMember {
  const primary = rewriteFusionEndpoint(member, fromModelId, toModelId, providerId)
  const fallback = rewriteFusionEndpoint(member.fallback, fromModelId, toModelId, providerId)
  if (primary === member && fallback === member.fallback) return member
  return {
    ...member,
    modelId: primary?.modelId ?? member.modelId,
    ...(primary?.providerId ? { providerId: primary.providerId } : {}),
    ...(fallback ? { fallback } : {}),
  }
}

function rewriteComboModelRefs(
  combo: CombinationModel,
  fromModelId: string,
  toModelId: string,
  providerId: string,
): CombinationModel {
  const panel = combo.panel.map((m) => rewriteFusionMember(m, fromModelId, toModelId, providerId))
  const vision = rewriteFusionEndpoint(combo.vision, fromModelId, toModelId, providerId)
  const judge = rewriteFusionEndpoint(combo.judge, fromModelId, toModelId, providerId)
  const synthesizer = rewriteFusionEndpoint(combo.synthesizer, fromModelId, toModelId, providerId)
  if (
    panel.every((m, i) => m === combo.panel[i]) &&
    vision === combo.vision &&
    judge === combo.judge &&
    synthesizer === combo.synthesizer
  ) {
    return combo
  }
  return {
    ...combo,
    panel,
    ...(vision ? { vision } : {}),
    ...(judge ? { judge } : {}),
    ...(synthesizer ? { synthesizer } : {}),
  }
}

export async function handlePostModel(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const id = typeof body.id === 'string' ? body.id.trim() : ''
  const previousId = typeof body.previousId === 'string' ? body.previousId.trim() : ''
  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
  if (!id) return c.json({ error: 'model id required' }, 400)
  if (!providerId) return c.json({ error: 'providerId required' }, 400)

  const reg0 = await readModelRegistry()
  if (!findProvider(reg0, providerId)) {
    return c.json({ error: `unknown provider "${providerId}"` }, 400)
  }
  const reasoningEffort = normalizeReasoningEffort(body.reasoningEffort)
  if (body.reasoningEffort != null && !reasoningEffort) {
    return c.json({ error: `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}` }, 400)
  }

  const cost = normalizeCostInput(body.cost)
  const model: ModelEntry = {
    id,
    providerId,
    label: typeof body.label === 'string' && body.label !== '' ? body.label : id,
    ...(MODEL_APIS.includes(body.api as ModelApi) ? { api: body.api as ModelApi } : {}),
    input: normalizeModalities(body.input),
    ...(typeof body.contextWindow === 'number' ? { contextWindow: body.contextWindow } : {}),
    ...(typeof body.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {}),
    ...(cost ? { cost } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    origin: 'manual',
  }

  const isRename = previousId !== '' && previousId !== id
  const reg = await mutateModelRegistry((r) => ({
    ...r,
    // Dedupe by (providerId, id) — the same model id can legitimately
    // exist under more than one provider, so a same-id row under a
    // different provider must survive this upsert untouched.
    models: [
      ...r.models.filter((m) => {
        if (m.providerId !== providerId) return true
        if (m.id === id) return false
        if (isRename && m.id === previousId) return false
        return true
      }),
      model,
    ],
    combos: isRename
      ? r.combos.map((combo) => rewriteComboModelRefs(combo, previousId, id, providerId))
      : r.combos,
  }))
  return c.json({ ok: true, models: reg.models })
}

// ── DELETE /api/routing/model?id=&providerId= ─────────────────────

export async function handleDeleteModel(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  // providerId is optional for back-compat with older UIs / scripts:
  // when missing, fall back to "any model with this id" (the previous
  // behavior). New UI always passes it so a delete on one provider's
  // copy doesn't take the sibling under another provider with it.
  const providerId = c.req.query('providerId')
  const reg = await mutateModelRegistry((r) => ({
    ...r,
    models: r.models.filter((m) => {
      if (m.id !== id) return true
      if (providerId !== undefined && m.providerId !== providerId) return true
      return false
    }),
  }))
  return c.json({ ok: true, models: reg.models })
}

// ── POST /api/routing/combo ───────────────────────────────────────
//
// Combination models — afw's local OpenRouter Fusion: a reusable panel of
// models (run in parallel) + an optional judge + synthesizer, stored in the
// registry. A route targets one by id (`{kind:'composite', comboId}`); the
// combo, not the route, owns its panel.

/** Normalize a {modelId, providerId?} endpoint (judge / synthesizer / vision
 *  bridge) from request input. Returns undefined when absent or invalid. */
function normalizeEndpointInput(raw: unknown): FusionEndpoint | undefined {
  if (!isObj(raw)) return undefined
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  if (!modelId) return undefined
  const providerId =
    typeof raw.providerId === 'string' && raw.providerId.trim() !== ''
      ? raw.providerId.trim()
      : undefined
  return { modelId, ...(providerId ? { providerId } : {}) }
}

/** Normalize one panel member from request input — the model, its per-member
 *  failover rules (`switchOn` — token/USD caps + error), and its `fallback`
 *  backup model. */
function normalizePanelMemberInput(raw: unknown): FusionMember | { error: string } {
  if (!isObj(raw)) return { error: 'each panel member must be an object' }
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
  if (!modelId) return { error: 'each panel member needs a modelId' }
  const providerId =
    typeof raw.providerId === 'string' && raw.providerId.trim() !== ''
      ? raw.providerId.trim()
      : undefined
  const switchOn = Array.isArray(raw.switchOn)
    ? raw.switchOn.map(normalizeSwitchRule).filter((r): r is SwitchRule => r != null)
    : []
  const fallback = normalizeEndpointInput(raw.fallback)
  return {
    modelId,
    ...(providerId ? { providerId } : {}),
    ...(switchOn.length > 0 ? { switchOn } : {}),
    ...(fallback ? { fallback } : {}),
  }
}

export async function handlePostCombo(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const providedId = typeof body.id === 'string' ? body.id.trim() : ''
  const name = typeof body.label === 'string' ? body.label.trim() : ''
  if (!providedId && !name) return c.json({ error: 'combination model name required' }, 400)

  // Accept `panel` (current) or `members` (legacy failover shape) as the panel.
  const rawPanel = Array.isArray(body.panel)
    ? body.panel
    : Array.isArray(body.members)
      ? body.members
      : null
  if (!rawPanel || rawPanel.length === 0) {
    return c.json({ error: 'a fusion model needs at least one panel member' }, 400)
  }
  if (rawPanel.length > MAX_FUSION_PANEL) {
    return c.json({ error: `a fusion panel can have at most ${MAX_FUSION_PANEL} members` }, 400)
  }

  const reg0 = await readModelRegistry()
  const toolStore = await readToolProviders()
  // Validate one model endpoint exists; returns an error string or null.
  const unknownModel = (e: FusionEndpoint | undefined, role: string): string | null => {
    if (!e) return null
    if (findModel(reg0, e.modelId, e.providerId)) return null
    return `unknown ${role} model "${e.providerId ? `${e.providerId}/` : ''}${e.modelId}"`
  }

  const panel: FusionMember[] = []
  for (const m of rawPanel) {
    const norm = normalizePanelMemberInput(m)
    if ('error' in norm) return c.json({ error: norm.error }, 400)
    const memberErr =
      unknownModel({ modelId: norm.modelId, providerId: norm.providerId }, 'panel') ??
      unknownModel(norm.fallback, 'fallback')
    if (memberErr) return c.json({ error: memberErr }, 400)
    panel.push(norm)
  }

  const vision = normalizeEndpointInput(body.vision)
  const judge = normalizeEndpointInput(body.judge)
  const synthesizer = normalizeEndpointInput(body.synthesizer)
  const cheapModel = normalizeEndpointInput(body.cheapModel)
  const endpointErr =
    unknownModel(vision, 'vision') ??
    unknownModel(judge, 'judge') ??
    unknownModel(synthesizer, 'synthesizer') ??
    unknownModel(cheapModel, 'cheap')
  if (endpointErr) return c.json({ error: endpointErr }, 400)

  // Fusion-level web_search pin → must be a real web_search tool provider.
  let webSearch: { providerId?: string } | undefined
  if (isObj(body.webSearch)) {
    const pid =
      typeof body.webSearch.providerId === 'string' && body.webSearch.providerId.trim() !== ''
        ? body.webSearch.providerId.trim()
        : undefined
    if (pid && !toolStore.providers.some((p) => p.id === pid && p.kind === 'web_search')) {
      return c.json({ error: `unknown web_search tool provider "${pid}"` }, 400)
    }
    webSearch = pid ? { providerId: pid } : {}
  }

  const id =
    providedId ||
    deriveId(
      name,
      reg0.combos.map((x) => x.id),
      'fusion',
    )
  const label = name || reg0.combos.find((x) => x.id === id)?.label || id
  const combo: CombinationModel = {
    id,
    label,
    panel,
    ...(vision ? { vision } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(judge ? { judge } : {}),
    ...(synthesizer ? { synthesizer } : {}),
    ...(cheapModel ? { cheapModel } : {}),
    origin: 'manual',
  }

  const reg = await mutateModelRegistry((r) => ({
    ...r,
    combos: [...r.combos.filter((x) => x.id !== id), combo],
  }))
  return c.json({ ok: true, combos: reg.combos })
}

// ── DELETE /api/routing/combo?id= ─────────────────────────────────

export async function handleDeleteCombo(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  // Routes that pointed at this combo aren't rewritten — they degrade to
  // passthrough at resolve time (logged). Surface them so the UI can warn.
  const policy = await readRoutingPolicy()
  const affectedRoutes = Object.entries(policy.agents)
    .filter(([, a]) => a.target.kind === 'composite' && a.target.comboId === id)
    .map(([k]) => k)
  const reg = await mutateModelRegistry((r) => ({
    ...r,
    combos: r.combos.filter((x) => x.id !== id),
  }))
  return c.json({
    ok: true,
    combos: reg.combos,
    ...(affectedRoutes.length > 0 ? { affectedRoutes } : {}),
  })
}

// ── POST /api/routing/list-models ─────────────────────────────────

/** A model id discovered from a provider's own `/v1/models` endpoint. */
export type DiscoveredModel = { id: string; label?: string }

/** Trim an upstream error body to a short single-line excerpt — strips
 *  HTML tags and collapses whitespace, for a readable inline UI error. */
function errorExcerpt(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Parse a provider's model-list response tolerantly. Handles OpenAI
 *  (`{data:[{id}]}`), Anthropic (`{data:[{id,display_name}]}`), an
 *  `{models:[…]}` envelope, and a bare array of objects or strings.
 *  Idless entries are dropped and ids de-duped. */
export function parseModelList(json: unknown): DiscoveredModel[] {
  const rows: unknown[] = Array.isArray(json)
    ? json
    : isObj(json) && Array.isArray(json.data)
      ? json.data
      : isObj(json) && Array.isArray(json.models)
        ? json.models
        : []
  const seen = new Set<string>()
  const out: DiscoveredModel[] = []
  for (const row of rows) {
    let id = ''
    let label: string | undefined
    if (typeof row === 'string') {
      id = row.trim()
    } else if (isObj(row)) {
      id =
        typeof row.id === 'string'
          ? row.id.trim()
          : typeof row.name === 'string'
            ? row.name.trim()
            : ''
      const dn = row.display_name ?? row.label
      if (typeof dn === 'string' && dn.trim() !== '') label = dn.trim()
    }
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(label ? { id, label } : { id })
  }
  return out
}

/** Build a provider's `/v1/models` URL, matching `generationUrl`'s
 *  convention that a base URL already ending in `/v1` is not doubled. */
export function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
}

/** When a baseUrl carries a protocol-translation path (e.g. DeepSeek's
 *  `https://api.deepseek.com/anthropic`), the inference endpoint lives
 *  under that path but the `/v1/models` listing is usually only
 *  implemented at the origin root. Returns the origin's `/v1/models`
 *  when distinct from the path-scoped one, or undefined when there's
 *  nothing different to try. parseModelList handles both Anthropic and
 *  OpenAI response shapes, so swapping which one we hit doesn't matter
 *  for the parsed result. */
export function rootModelsUrlFallback(baseUrl: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return undefined
  }
  // Treat "/" and "/v1" as already-root paths — no fallback needed.
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/v1') return undefined
  const root = `${parsed.protocol}//${parsed.host}`
  const fallback = `${root}/v1/models`
  return fallback === modelsUrl(baseUrl) ? undefined : fallback
}

// Discovery for the "List models" button on the Add-provider form. Issues
// exactly one GET to the user's own configured provider baseUrl with the
// user's own key, only on an explicit click — contacts no afw/Anthropic
// server and sends no identifiers. Within the PRIVACY.md contract. Never
// throws: a network error or a non-2xx upstream becomes a 502 {error}.
export async function handlePostListModels(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const api = body.api
  if (!baseUrl) return c.json({ error: 'baseUrl required' }, 400)
  if (!MODEL_APIS.includes(api as ModelApi)) {
    return c.json({ error: `api must be one of ${MODEL_APIS.join(', ')}` }, 400)
  }

  const headers = new Headers({ accept: 'application/json' })
  if (api === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01')

  const authKind = body.authKind
  if (authKind === 'bearer' || authKind === 'api-key') {
    // The form may carry the key directly; otherwise fall back to the
    // secret already stored for an existing provider.
    let key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (key === '') {
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
      if (providerId !== '') {
        key = getSecret(await readSecrets(), `provider:${providerId}`) ?? ''
      }
    }
    if (key === '') {
      return c.json({ error: "an API key is required to list this provider's models" }, 400)
    }
    if (authKind === 'bearer') {
      headers.set('authorization', `Bearer ${key}`)
    } else {
      const header = typeof body.authHeader === 'string' ? body.authHeader.trim() : ''
      if (!header) return c.json({ error: 'authHeader required for api-key auth' }, 400)
      headers.set(header, key)
    }
  }

  // Try the path-scoped /v1/models first. If it fails (4xx/5xx, network,
  // non-JSON), and the baseUrl has a protocol-translation path like
  // `/anthropic`, try the origin's /v1/models — many third-party
  // providers (e.g. DeepSeek) only implement the inference endpoints
  // under the protocol-prefixed path but expose the models listing at
  // the root. parseModelList handles both wire shapes so the swap is
  // transparent.
  const result = await tryFetchModels(modelsUrl(baseUrl), headers)
  if (result.ok) return c.json({ models: result.models })

  const fallbackUrl = rootModelsUrlFallback(baseUrl)
  if (fallbackUrl) {
    const fallback = await tryFetchModels(fallbackUrl, headers)
    if (fallback.ok) return c.json({ models: fallback.models })
  }
  return c.json({ error: result.error }, 502)
}

type TryFetchResult = { ok: true; models: DiscoveredModel[] } | { ok: false; error: string }

async function tryFetchModels(url: string, headers: Headers): Promise<TryFetchResult> {
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    return { ok: false, error: `could not reach ${url}: ${(err as Error).message}` }
  }
  const text = await res.text().catch(() => '')
  if (res.status >= 400) {
    return { ok: false, error: `provider returned HTTP ${res.status}: ${errorExcerpt(text)}` }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: `provider returned a non-JSON response: ${errorExcerpt(text)}` }
  }
  return { ok: true, models: parseModelList(json) }
}

// ── GET /api/routing/policy ───────────────────────────────────────

// The Routing view renders one card per wire route. Excluded here:
//   • MCP routes — they carry no model traffic.
//   • routes for agents not currently wired — `afw unwire` deliberately
//     leaves stale entries in routes.json, so without this filter the page
//     shows dead cards for agents that were wired at some point in the past.
export async function handleGetPolicy(c: Context): Promise<Response> {
  const policy = await readRoutingPolicy()
  const reg = await readModelRegistry()
  const manifest = await readManifest()
  const toolStore = await readToolProviders()
  // Match handleWireStatus: "wired" = has a (non-tombstoned) route OR a
  // manifest entry. Manual-mode agents like claude-desktop with no MCP
  // wraps only show up in routes.json, never in the manifest — without
  // this union their card never gets per-source-model rows.
  const wiredAgents = new Set<string>(manifest.entries.map((e) => e.agent))
  for (const [routeKey, entry] of Object.entries(getRoutes().routes)) {
    if (entry.tombstoned) continue
    const slash = routeKey.indexOf('/')
    if (slash > 0) wiredAgents.add(routeKey.slice(0, slash))
  }

  // Agents that have the afw-tools MCP injected — identified by a
  // manifest entry that set `/mcpServers/afw` (or the legacy
  // `/mcpServers/afw` from before the rename). The routing card surfaces
  // this as a "Tools" block per agent so the user can see which capabilities
  // afw already fills locally vs which still require the upstream's
  // server-side implementation.
  const toolsPointers = new Set(['/mcpServers/afw', '/mcpServers/afw'])
  const agentsWithAfwTools = new Set<string>()
  for (const e of manifest.entries) {
    if (e.changes.some((c) => c.type === 'set' && toolsPointers.has(c.jsonPointer))) {
      agentsWithAfwTools.add(e.agent)
    }
  }
  const webSearchProvider = activeProviderFor(toolStore, 'web_search' as ToolKind)
  // The set of tools the afw-tools MCP exposes today. Hard-coded for
  // now — when the binary grows new tools this list should be the
  // single source of truth; for v0 keeping it inline avoids spinning
  // up the MCP just to introspect it.
  const afwToolsDescriptors = [
    { name: 'web_search', backend: webSearchProvider?.backend ?? 'unconfigured' },
    { name: 'web_fetch', backend: 'local' },
  ]
  const routes = Object.entries(getRoutes().routes)
    .filter(([, entry]) => entry.decoder !== 'mcp')
    .map(([routeKey, entry]) => {
      // routeKey is `<agentType>/<modelId>` (exact wrap) or
      // `<agentType>/*` (wildcard for OAuth-style). Split into the two
      // segments for UI display + dispatch.
      const slash = routeKey.indexOf('/')
      const agent = slash >= 0 ? routeKey.slice(0, slash) : routeKey
      const modelId = slash >= 0 ? routeKey.slice(slash + 1) : ''
      // Source models seen on this route — the UI renders one
      // per-source-model row per entry so wildcard (OAuth) agents can
      // carry per-model overrides alongside the agent default.
      // Populated by noteObservedModel from observed traffic and (for
      // OAuth agents) pre-seeded from KNOWN_SOURCE_MODELS at wire time.
      const sourceModels = reg.models
        .filter((m) => m.providerId === routeKey)
        .map((m) => ({
          id: m.id,
          label: m.label,
          ...(m.input ? { input: m.input } : {}),
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
      // Local afw tools the agent has been wired with. Empty for
      // agents that haven't been (re)wired since the afw-tools
      // injection landed.
      const tools = agentsWithAfwTools.has(agent) ? afwToolsDescriptors : []
      return {
        routeKey,
        agent,
        modelId,
        decoder: entry.decoder,
        upstream: entry.upstream,
        sourceModels,
        tools,
        ...(entry.sourceModelId ? { sourceModelId: entry.sourceModelId } : {}),
      }
    })
    .filter((r) => wiredAgents.has(r.agent))
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey))
  // Resolve the subagent cost-saver to its effective (default-merged) config
  // so the UI shows the real state even when routing.json has no override.
  return c.json({ policy, routes, subagentDowngrade: effectiveSubagentDowngrade(policy) })
}

// ── POST /api/routing/subagent ────────────────────────────────────

/** Update the global Claude Code subagent cost-saver. Patches
 *  `policy.subagentDowngrade` from the effective (default-merged) config so a
 *  partial body (e.g. just `{enabled:false}`) is a safe toggle. Mirrors the
 *  `afw route subagent` CLI. */
export async function handlePostSubagent(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const next = effectiveSubagentDowngrade(await readRoutingPolicy())
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled
  if (typeof body.modelId === 'string' && body.modelId.trim() !== '') {
    next.modelId = body.modelId.trim()
  }
  if (typeof body.providerId === 'string') {
    const pid = body.providerId.trim()
    if (pid) next.providerId = pid
    else next.providerId = undefined
  }
  if (typeof body.minMaxTokens === 'number' && body.minMaxTokens >= 0) {
    next.minMaxTokens = body.minMaxTokens
  }
  await mutateRoutingPolicy((p) => ({ ...p, subagentDowngrade: next }))
  return c.json({ ok: true, subagentDowngrade: next })
}

// ── POST /api/routing/agent ───────────────────────────────────────

function normalizeMemberInput(raw: unknown): ChainMember | { error: string } {
  if (!isObj(raw)) return { error: 'each member must be an object' }
  if (typeof raw.modelId !== 'string' || raw.modelId === '') {
    return { error: 'each member needs a modelId' }
  }
  const switchOn = Array.isArray(raw.switchOn)
    ? raw.switchOn.map(normalizeSwitchRule).filter((r): r is SwitchRule => r != null)
    : []
  return {
    modelId: raw.modelId,
    ...(typeof raw.providerId === 'string' && raw.providerId !== ''
      ? { providerId: raw.providerId }
      : {}),
    ...(switchOn.length > 0 ? { switchOn } : {}),
  }
}

export function normalizeTargetInput(raw: unknown): RoutingTarget | { error: string } {
  if (!isObj(raw)) return { error: 'target must be an object' }
  if (raw.kind === 'passthrough') return { kind: 'passthrough' }
  if (raw.kind === 'composite') {
    const comboId = typeof raw.comboId === 'string' ? raw.comboId.trim() : ''
    if (!comboId) return { error: 'composite target needs a comboId' }
    return { kind: 'composite', comboId }
  }
  if (raw.kind === 'chain') {
    if (!Array.isArray(raw.members) || raw.members.length === 0) {
      return { error: 'chain target needs at least one member' }
    }
    const members: ChainMember[] = []
    for (const m of raw.members) {
      const norm = normalizeMemberInput(m)
      if ('error' in norm) return { error: norm.error }
      members.push(norm)
    }
    return { kind: 'chain', members }
  }
  return { error: 'target.kind must be passthrough, chain, or composite' }
}

export async function handlePostAgent(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const routeKey = typeof body.routeKey === 'string' ? body.routeKey.trim() : ''
  if (!routeKey) return c.json({ error: 'routeKey required' }, 400)

  const target = normalizeTargetInput(body.target)
  if ('error' in target) return c.json({ error: target.error }, 400)

  // Validate every chain member's model so the UI gets a real error rather
  // than a silent passthrough fallback at request time.
  const reg = await readModelRegistry()
  if (target.kind === 'chain') {
    for (const m of target.members) {
      if (!findModel(reg, m.modelId, m.providerId)) {
        const where = m.providerId ? `model "${m.providerId}/${m.modelId}"` : `model "${m.modelId}"`
        return c.json({ error: `unknown ${where}` }, 400)
      }
    }
  }
  if (target.kind === 'composite' && !findCombo(reg, target.comboId)) {
    return c.json({ error: `unknown combination model "${target.comboId}"` }, 400)
  }

  // `passthrough` collapses to "no entry" only on the bare-agent wildcard
  // (`<agent>/*`) — there it IS the default, and dropping the entry keeps
  // routing.json minimal. An exact-match key (`claude-code/claude-opus-4-7`)
  // OR a per-instance key (`claude-code@worker-3/*`, minted by
  // `afw run --monitor`) must store its passthrough explicitly: the
  // instance's "leave me untouched" has to shadow a type-level model
  // override, which a deleted entry would fall straight through.
  const isWildcardKey = routeKey.endsWith('/*') && !routeKey.includes('@')
  const policy = await mutateRoutingPolicy((p) => {
    const agents = { ...p.agents }
    if (target.kind === 'passthrough' && isWildcardKey) {
      delete agents[routeKey]
    } else {
      agents[routeKey] = { target }
    }
    return { ...p, agents }
  })
  clearBudgetCache()

  // Ensure the proxy can actually accept this agent's traffic. CLI agents
  // (claude-code, codex) get a routes.json entry at launch via ensureWireRoute,
  // but app/daemon agents (hermes, openclaw) are pointed at the wire by hand and
  // have no launch step — without a routes.json entry the proxy 502s before
  // routing ever runs. Seed a minimal wildcard route the first time a non-
  // passthrough policy is set for an agent that has none. Composite/chain
  // targets don't use the route's upstream (members carry their own provider),
  // and app/daemon agents speak OpenAI-chat to the wire, so these defaults are
  // safe; an existing model route is never overwritten.
  const seededRoute = target.kind === 'passthrough' ? undefined : await ensureWireRouteFor(routeKey)

  return c.json({ ok: true, policy, ...(seededRoute ? { seededRoute } : {}) })
}

/** Bare agent id from a route key: `hermes/*` → `hermes`,
 *  `hermes@worker/x` → `hermes`. */
export function bareAgentOf(routeKey: string): string {
  const slash = routeKey.indexOf('/')
  const seg = slash >= 0 ? routeKey.slice(0, slash) : routeKey
  return seg.split('@')[0] ?? seg
}

/** Create a wildcard wire route for `routeKey`'s agent when it has no model
 *  route yet. Returns the seeded key, or undefined when one already existed.
 *  MCP routes (`<agent>/mcp/<name>`) don't count — they carry no model traffic. */
async function ensureWireRouteFor(routeKey: string): Promise<string | undefined> {
  const agent = bareAgentOf(routeKey)
  if (!agent) return undefined
  const hasModelRoute = Object.keys(getRoutes().routes).some((k) => {
    const slash = k.indexOf('/')
    if (slash < 0) return false
    return bareAgentOf(k) === agent && !k.slice(slash + 1).startsWith('mcp/')
  })
  if (hasModelRoute) return undefined
  const key = `${agent}/*`
  // `.invalid` never resolves, so a passthrough that ever hits this seeded
  // route fails loudly instead of silently forwarding somewhere wrong — the
  // upstream is only a placeholder for swap targets that don't read it.
  await upsertRoutes({
    [key]: { upstream: 'http://afw-unconfigured.invalid', decoder: 'openai-chat' },
  })
  logger.info(`routing: seeded wire route ${key} (decoder openai-chat) for ${agent}`)
  return key
}

// ── POST /api/routing/capability ──────────────────────────────────

/** Set a per-route capability fulfillment (vision-companion etc.).
 *  Mutates `policy.agents[routeKey].capabilities[capabilityId]`.
 *  Auto-deleting the entry on `via:'local'` is intentional: local is
 *  the implicit default for any tool we ship (e.g. web_search via the
 *  afw-tools MCP), so storing it explicitly just adds noise. Use
 *  the DELETE endpoint when you want to revert a companion override. */
const KNOWN_CAPABILITY_IDS = new Set(['vision', 'web_search'])

export async function handlePostCapability(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const routeKey = typeof body.routeKey === 'string' ? body.routeKey.trim() : ''
  if (!routeKey) return c.json({ error: 'routeKey required' }, 400)
  const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId.trim() : ''
  if (!KNOWN_CAPABILITY_IDS.has(capabilityId)) {
    return c.json(
      { error: `capabilityId must be one of ${[...KNOWN_CAPABILITY_IDS].join(', ')}` },
      400,
    )
  }

  const fulfillment = body.fulfillment
  if (!isObj(fulfillment)) {
    return c.json({ error: 'fulfillment object required' }, 400)
  }

  const via = fulfillment.via
  if (via !== 'companion' && via !== 'local') {
    return c.json({ error: "fulfillment.via must be 'companion' or 'local'" }, 400)
  }

  // Validate the referenced model when via='companion'.
  let normalized: import('../../core/routing-policy.ts').CapabilityFulfillment
  if (via === 'companion') {
    const modelId = typeof fulfillment.modelId === 'string' ? fulfillment.modelId : ''
    if (!modelId) return c.json({ error: 'companion fulfillment needs a modelId' }, 400)
    const providerId =
      typeof fulfillment.providerId === 'string' ? fulfillment.providerId : undefined
    const reg = await readModelRegistry()
    if (!findModel(reg, modelId, providerId)) {
      const where = providerId ? `${providerId}/${modelId}` : modelId
      return c.json({ error: `unknown companion model "${where}"` }, 400)
    }
    normalized = providerId
      ? { via: 'companion', modelId, providerId }
      : { via: 'companion', modelId }
  } else {
    const providerId =
      typeof fulfillment.providerId === 'string' && fulfillment.providerId !== ''
        ? fulfillment.providerId
        : undefined
    normalized = providerId ? { via: 'local', providerId } : { via: 'local' }
  }

  const policy = await mutateRoutingPolicy((p) => {
    const agents = { ...p.agents }
    const prior = agents[routeKey] ?? { target: { kind: 'passthrough' as const } }
    const capabilities = { ...(prior.capabilities ?? {}) }
    capabilities[capabilityId as 'vision' | 'web_search'] = normalized
    agents[routeKey] = { ...prior, capabilities }
    return { ...p, agents }
  })
  clearBudgetCache()
  return c.json({ ok: true, policy })
}

// ── DELETE /api/routing/capability?routeKey=&capabilityId= ────────

export async function handleDeleteCapability(c: Context): Promise<Response> {
  const routeKey = c.req.query('routeKey')
  const capabilityId = c.req.query('capabilityId')
  if (!routeKey) return c.json({ error: 'missing routeKey' }, 400)
  if (!capabilityId || !KNOWN_CAPABILITY_IDS.has(capabilityId)) {
    return c.json({ error: 'missing or unknown capabilityId' }, 400)
  }
  const policy = await mutateRoutingPolicy((p) => {
    const prior = p.agents[routeKey]
    if (!prior?.capabilities) return undefined
    if (!(capabilityId in prior.capabilities)) return undefined
    const capabilities = { ...prior.capabilities }
    delete capabilities[capabilityId as 'vision' | 'web_search']
    const next = { ...prior }
    if (Object.keys(capabilities).length === 0) next.capabilities = undefined
    else next.capabilities = capabilities
    return { ...p, agents: { ...p.agents, [routeKey]: next } }
  })
  clearBudgetCache()
  return c.json({ ok: true, policy })
}

// ── DELETE /api/routing/agent?routeKey= ───────────────────────────

/** Remove an agent routing entry outright — the UI's "Use default"
 *  action on a per-source-model row. With the entry gone, routingFor's
 *  exact→wildcard fallback takes over: the source model now inherits
 *  whatever the `<agent>/*` default is. POSTing passthrough on the same
 *  key would *store* an explicit passthrough — different semantics. */
export async function handleDeleteAgent(c: Context): Promise<Response> {
  const routeKey = c.req.query('routeKey')
  if (!routeKey) return c.json({ error: 'missing routeKey' }, 400)
  const policy = await mutateRoutingPolicy((p) => {
    if (!(routeKey in p.agents)) return undefined
    const agents = { ...p.agents }
    delete agents[routeKey]
    return { ...p, agents }
  })
  clearBudgetCache()
  return c.json({ ok: true, policy })
}

// ── POST /api/routing/secret ──────────────────────────────────────

export async function handlePostSecret(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
  const value = typeof body.value === 'string' ? body.value : ''
  if (!ref) return c.json({ error: 'ref required' }, 400)
  if (!value) return c.json({ error: 'value required' }, 400)
  const store = await setSecret(ref, value)
  return c.json({ ok: true, secretRefs: secretRefs(store) })
}

// ── DELETE /api/routing/secret?ref= ───────────────────────────────

export async function handleDeleteSecret(c: Context): Promise<Response> {
  const ref = c.req.query('ref')
  if (!ref) return c.json({ error: 'missing ref' }, 400)
  const store = await removeSecret(ref)
  return c.json({ ok: true, secretRefs: secretRefs(store) })
}

// ── GET /api/routing/spend ────────────────────────────────────────

// Last-24h spend per model id. Routed children carry the real model id and
// real cost; the $0 parent rows fold in harmlessly.
export async function handleGetSpend(c: Context): Promise<Response> {
  const rows = await recentModels(Date.now() - ONE_DAY)
  const byModel = new Map<string, { costUsd: number; calls: number }>()
  for (const r of rows) {
    const acc = byModel.get(r.model) ?? { costUsd: 0, calls: 0 }
    acc.costUsd += r.costMicro / 1_000_000
    acc.calls += r.uses
    byModel.set(r.model, acc)
  }
  const spend = [...byModel.entries()]
    .map(([model, v]) => ({ model, costUsd: v.costUsd, calls: v.calls }))
    .sort((a, b) => b.costUsd - a.costUsd)
  return c.json({ spend })
}

// ── GET /api/routing/baseline ─────────────────────────────────────

// Smallest observed model-call input size for an agent (last 30 days) — the
// launcher uses it to decide whether lowering Claude Code's auto-compaction
// window would fire on the first prompt. Null when there's no traffic yet.
const THIRTY_DAYS = 30 * ONE_DAY
export async function handleGetBaseline(c: Context): Promise<Response> {
  const agent = c.req.query('agent')
  if (!agent) return c.json({ error: 'agent required' }, 400)
  const baselineTokens = await baselineInputTokens(agent, Date.now() - THIRTY_DAYS)
  return c.json({ baselineTokens })
}
