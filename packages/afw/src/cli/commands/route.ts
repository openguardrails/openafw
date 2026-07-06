// `afw route` — configure per-agent model routing from the terminal.
// A thin client over the daemon's /api/routing surface, with parity to the
// model-routing dashboard.

import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import {
  type CombinationModel,
  GENERATION_PATH_MODES,
  type GenerationPathMode,
  type ModelApi,
  type ModelEntry,
  type ProviderEntry,
  REASONING_EFFORTS,
  type ReasoningEffort,
  TOOL_CALL_PARSERS,
} from '../../core/model-registry.ts'
import { DAEMON_BASE_URL } from '../../core/paths.ts'
import type {
  AgentRouting,
  ChainMember,
  RoutingPolicy,
  RoutingTarget,
} from '../../core/routing-policy.ts'
import {
  effectiveSubagentDowngrade,
  mutateRoutingPolicy,
  readRoutingPolicy,
} from '../../core/routing-policy.ts'
import { promptSecret } from '../util/prompt.ts'

const MODEL_APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']

function normalizeReasoningEffortFlag(raw?: string): ReasoningEffort | undefined {
  if (raw == null) return undefined
  const value = raw.trim().toLowerCase()
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined
}

function normalizeGenerationPathFlag(raw?: string): GenerationPathMode | undefined {
  if (raw == null) return undefined
  const value = raw.trim().toLowerCase()
  return GENERATION_PATH_MODES.includes(value as GenerationPathMode)
    ? (value as GenerationPathMode)
    : undefined
}

function providerSecretRef(id: string): string {
  return `provider:${id}`
}

type RegistryResponse = {
  providers: ProviderEntry[]
  models: ModelEntry[]
  combos: CombinationModel[]
  secretRefs: string[]
}
type RoutingRoute = {
  routeKey: string
  agent: string
  provider: string
  decoder: string
}
type PolicyResponse = { policy: RoutingPolicy; routes: RoutingRoute[] }

// ── daemon client ─────────────────────────────────────────────────

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${DAEMON_BASE_URL}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new Error('cannot reach the afw daemon — start it with `afw daemon start`')
  }
  const text = await res.text()
  let json: unknown = {}
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = {}
    }
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`
    throw new Error(msg)
  }
  return json as T
}

function fail(message: string): void {
  logger.print(`error: ${message}`)
  process.exitCode = 1
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    fail((e as Error).message)
  }
}

function describeTarget(t: RoutingTarget, combos?: CombinationModel[]): string {
  if (t.kind === 'chain') {
    if (t.members.length === 1) return `→ model ${t.members[0]!.modelId}`
    return `→ chain ${t.members.map((m) => m.modelId).join(' → ')}`
  }
  if (t.kind === 'composite') {
    const c = combos?.find((x) => x.id === t.comboId)
    return `→ fusion ${c?.label ?? t.comboId}`
  }
  return 'passthrough'
}

// A fusion model's one-line shape for `route fusion list`: the parallel panel
// (with per-member fallbacks), then the judge and synthesizer (each defaulting
// when unset), plus the combo-level vision companion.
function describeFusion(c: CombinationModel): string {
  const panel = c.panel
    .map((m) => (m.fallback ? `${m.modelId}→${m.fallback.modelId}` : m.modelId))
    .join(' + ')
  const judge = c.judge?.modelId ?? '(synthesizer)'
  const synth = c.synthesizer?.modelId ?? c.panel[0]?.modelId ?? '—'
  const extras: string[] = []
  if (c.vision) extras.push(`vision ${c.vision.modelId}`)
  if (c.webSearch) extras.push('web_search')
  return `panel [${panel}] · judge ${judge} → synth ${synth}${extras.length ? ` · ${extras.join(' · ')}` : ''}`
}

// The vision companion, if any, rendered for `list`/`show`. A text-only
// routed model paired with a multimodal companion that sees the images.
function describeVision(routing: AgentRouting | undefined): string {
  const cap = routing?.capabilities?.vision
  if (!cap || cap.via !== 'companion') return ''
  const ref = cap.providerId ? `${cap.providerId}/${cap.modelId}` : cap.modelId
  return `vision→${ref}`
}

// A bare model list becomes a clean error-failover chain: every member but
// the last advances on an upstream error; the last is the final fallback.
function chainMembers(modelIds: string[]): ChainMember[] {
  return modelIds.map((modelId, i) => ({
    modelId,
    ...(i < modelIds.length - 1 ? { switchOn: [{ kind: 'error' as const }] } : {}),
  }))
}

function collect(value: string, acc: string[]): string[] {
  return [...acc, value]
}

// ── route list / show / set ───────────────────────────────────────

const listCmd = new Command('list')
  .description('List wire routes and their model routing.')
  .action(() =>
    run(async () => {
      const [{ policy, routes }, reg] = await Promise.all([
        apiFetch<PolicyResponse>('GET', '/api/routing/policy'),
        apiFetch<RegistryResponse>('GET', '/api/routing/registry'),
      ])
      if (routes.length === 0) {
        logger.print(
          'No wire routes yet. Launch an agent (`afw claude`) or run `afw model add`.',
        )
        return
      }
      for (const route of routes) {
        const routing = policy.agents[route.routeKey]
        const target = routing ? describeTarget(routing.target, reg.combos) : 'passthrough'
        const vision = describeVision(routing)
        logger.print(`  ${route.routeKey.padEnd(36)} ${target}${vision ? `   ${vision}` : ''}`)
      }
    }),
  )

const showCmd = new Command('show')
  .description('Show the routing for one <agent>/<provider> route.')
  .argument('<routeKey>', 'route key, e.g. openclaw/anthropic')
  .action((routeKey: string) =>
    run(async () => {
      const [{ policy, routes }, reg] = await Promise.all([
        apiFetch<PolicyResponse>('GET', '/api/routing/policy'),
        apiFetch<RegistryResponse>('GET', '/api/routing/registry'),
      ])
      const route = routes.find((r) => r.routeKey === routeKey)
      if (!route) return fail(`unknown route "${routeKey}"`)
      const routing = policy.agents[routeKey]
      logger.print(`Route:   ${route.routeKey}`)
      logger.print(`Decoder: ${route.decoder}`)
      logger.print(
        `Target:  ${routing ? describeTarget(routing.target, reg.combos) : 'passthrough'}`,
      )
      const target = routing?.target
      if (target?.kind === 'composite') {
        const c = reg.combos.find((x) => x.id === target.comboId)
        if (c) logger.print(`Fusion:  ${describeFusion(c)}`)
      }
      const vision = describeVision(routing)
      logger.print(
        `Vision:  ${vision ? vision.replace('vision→', 'companion ') : 'native (routed model sees images)'}`,
      )
    }),
  )

type SetOpts = { model?: string; chain?: string[]; fusion?: string; passthrough?: boolean }

const setCmd = new Command('set')
  .description(
    'Route an <agent>/<sourceModel> (or the wildcard <agent>/*) to a model, a failover chain, a fusion model, or passthrough.\n' +
      '  Examples:\n' +
      '    afw route set claude-code/* --model glm-4.6\n' +
      '    afw route set claude-code/* --chain glm-4.6 --chain deepseek-v4    # error-failover\n' +
      '    afw route set claude-code/* --fusion frontier-panel               # a Model Fusion combo\n' +
      '    afw route set claude-code/claude-opus-4-7 --passthrough            # pin Opus back to Anthropic',
  )
  .argument('<routeKey>', 'route key, e.g. claude-code/* or claude-code/claude-sonnet-4-6')
  .option('--model <id>', 'route to a single model (a 1-member chain)')
  .option(
    '--chain <id>',
    'append a model to a failover chain — repeat the flag in failover order. Every member but the last switches on upstream error; for budget/token rules, use the dashboard.',
    collect,
    [] as string[],
  )
  .option(
    '--fusion <comboId>',
    'route to a Model Fusion combo (parallel panel → judge → synthesize). Build one on the dashboard or list them with `afw route fusion list`.',
  )
  .option('--passthrough', 'restore plain passthrough (the default)')
  .action((routeKey: string, opts: SetOpts) =>
    run(async () => {
      const chainIds = opts.chain ?? []
      const chosen = [
        opts.model,
        chainIds.length > 0 ? '_chain' : undefined,
        opts.fusion,
        opts.passthrough,
      ].filter(Boolean)
      if (chosen.length !== 1) {
        return fail('pass exactly one of --model, --chain, --fusion, or --passthrough')
      }
      const target: RoutingTarget = opts.model
        ? { kind: 'chain', members: [{ modelId: opts.model }] }
        : chainIds.length > 0
          ? { kind: 'chain', members: chainMembers(chainIds) }
          : opts.fusion
            ? { kind: 'composite', comboId: opts.fusion }
            : { kind: 'passthrough' }
      await apiFetch('POST', '/api/routing/agent', { routeKey, target })
      // describeTarget needs the combo label for a fusion target; fetch the
      // registry only on that branch so the common cases stay one round trip.
      const combos =
        target.kind === 'composite'
          ? (await apiFetch<RegistryResponse>('GET', '/api/routing/registry')).combos
          : undefined
      logger.print(`✓ ${routeKey} ${describeTarget(target, combos)}`)
    }),
  )

const unsetCmd = new Command('unset')
  .description(
    "Remove a per-source-model routing entry. The source model inherits the agent's <agent>/* default again. " +
      'Use `route set <key> --passthrough` instead if you want to pin it to passthrough explicitly.',
  )
  .argument('<routeKey>', 'route key, e.g. claude-code/claude-opus-4-7')
  .action((routeKey: string) =>
    run(async () => {
      await apiFetch('DELETE', `/api/routing/agent?routeKey=${encodeURIComponent(routeKey)}`)
      logger.print(`✓ ${routeKey} unset (inherits agent default)`)
    }),
  )

// ── route vision (text model + multimodal companion) ──────────────
//
// When a route sends traffic to a text-only model, images in the request
// can't be seen by it. A vision companion is a side-call to a multimodal
// model that describes the images first; the routed text model then works
// on the request with those descriptions spliced in (see the orchestrator's
// vision loop / image-predescribe). This is how you pair, e.g., a cheap
// text model with a multimodal one for the occasional screenshot.

type VisionOpts = { companion?: string; provider?: string; off?: boolean }

const visionCmd = new Command('vision')
  .description(
    'Attach a multimodal companion to a route whose model is text-only, so images\n' +
      '  are described by the companion before the routed model sees the request.\n' +
      '  Examples:\n' +
      '    afw route vision claude-code/*                              # show current\n' +
      '    afw route vision claude-code/* --companion gpt-4o-mini      # pair a companion\n' +
      '    afw route vision claude-code/* --companion qwen-vl --provider dashscope\n' +
      '    afw route vision claude-code/* --off                       # drop the companion',
  )
  .argument('<routeKey>', 'route key, e.g. claude-code/* or claude-code/glm-4.6')
  .option('--companion <id>', 'multimodal model that handles images for this route')
  .option(
    '--provider <id>',
    'disambiguate the companion when the id exists under several providers',
  )
  .option('--off', 'remove the vision companion — images go to the routed model as-is')
  .action((routeKey: string, opts: VisionOpts) =>
    run(async () => {
      if (opts.off && opts.companion) throw new Error('pass only one of --companion / --off')

      // No mutating flag: show the route's current vision wiring.
      if (!opts.off && !opts.companion) {
        const { policy, routes } = await apiFetch<PolicyResponse>('GET', '/api/routing/policy')
        if (!routes.some((r) => r.routeKey === routeKey)) return fail(`unknown route "${routeKey}"`)
        const vision = describeVision(policy.agents[routeKey])
        logger.print(
          vision
            ? `${routeKey}: ${vision.replace('vision→', 'vision companion ')}`
            : `${routeKey}: no vision companion (routed model sees images natively)`,
        )
        return
      }

      if (opts.off) {
        await apiFetch(
          'DELETE',
          `/api/routing/capability?routeKey=${encodeURIComponent(routeKey)}&capabilityId=vision`,
        )
        logger.print(`✓ ${routeKey} vision companion removed`)
        return
      }

      // Setting a companion. Warn (don't block) when the chosen model isn't
      // marked vision-capable — the daemon only checks existence.
      const reg = await apiFetch<RegistryResponse>('GET', '/api/routing/registry')
      const model = reg.models.find(
        (m) => m.id === opts.companion && (!opts.provider || m.providerId === opts.provider),
      )
      if (model && !model.input.includes('image')) {
        logger.print(
          `warning: companion "${opts.companion}" is not marked as accepting image input — register it with image input or it can't describe the images.`,
        )
      }
      await apiFetch('POST', '/api/routing/capability', {
        routeKey,
        capabilityId: 'vision',
        fulfillment: {
          via: 'companion',
          modelId: opts.companion,
          ...(opts.provider ? { providerId: opts.provider } : {}),
        },
      })
      const ref = opts.provider ? `${opts.provider}/${opts.companion}` : opts.companion
      logger.print(`✓ ${routeKey} vision → companion ${ref}`)
    }),
  )

// ── route fusion (Model Fusion combos) ────────────────────────────
//
// A fusion model runs a panel of models in parallel, a judge distils their
// answers into a structured analysis, and a synthesizer writes the final
// answer. Authoring a panel (per-member vision bridge, web_search) lives on the
// dashboard's rich editor; the CLI lists them and assigns one with
// `route set <key> --fusion <id>`.

const fusionList = new Command('list')
  .description('List configured Model Fusion combos (panel → judge → synthesize).')
  .action(() =>
    run(async () => {
      const reg = await apiFetch<RegistryResponse>('GET', '/api/routing/registry')
      if (!reg.combos || reg.combos.length === 0) {
        logger.print(
          'No fusion models yet. Build one on the dashboard (`afw ui` → Routing → Models).',
        )
        return
      }
      for (const c of reg.combos) {
        logger.print(`  ${c.id.padEnd(24)} ${c.label}`)
        logger.print(`  ${' '.repeat(24)} ${describeFusion(c)}`)
      }
    }),
  )

const fusionCmd = new Command('fusion')
  .description('List Model Fusion combos (build them on the dashboard).')
  .addCommand(fusionList)

// ── route provider ────────────────────────────────────────────────

type ProviderAddOpts = {
  baseUrl: string
  api: string
  auth: string
  header?: string
  label?: string
  key?: string
  generationPath?: string
  reasoningEffort?: string
  toolCallParser?: string
}

const providerAdd = new Command('add')
  .description('Register a model provider.')
  .argument('<id>', 'provider id')
  .requiredOption('--base-url <url>', 'provider base URL')
  .requiredOption('--api <api>', `wire format: ${MODEL_APIS.join(' | ')}`)
  .option('--auth <kind>', 'passthrough | bearer | api-key', 'passthrough')
  .option('--header <name>', 'header name for api-key auth, e.g. x-api-key')
  .option('--label <text>', 'display label')
  .option('--key <value>', 'API key (prompted without echo if omitted)')
  .option(
    '--generation-path <mode>',
    `generation endpoint path mode: ${GENERATION_PATH_MODES.join(' | ')}`,
  )
  .option(
    '--reasoning-effort <effort>',
    `provider default reasoning effort: ${REASONING_EFFORTS.join(' | ')}`,
  )
  .option(
    '--tool-call-parser <dialect>',
    `parse in-content tool calls this endpoint emits instead of native calls ` +
      `(afw's --tool-call-parser, e.g. a GLM/vLLM glm47 endpoint): ${TOOL_CALL_PARSERS.join(' | ')}`,
  )
  .action((id: string, opts: ProviderAddOpts) =>
    run(async () => {
      if (!MODEL_APIS.includes(opts.api as ModelApi)) {
        return fail(`--api must be one of ${MODEL_APIS.join(', ')}`)
      }
      if (!['passthrough', 'bearer', 'api-key'].includes(opts.auth)) {
        return fail('--auth must be passthrough, bearer, or api-key')
      }
      if (opts.auth === 'api-key' && !opts.header) {
        return fail('--header is required for api-key auth')
      }
      if (opts.toolCallParser != null && !TOOL_CALL_PARSERS.includes(opts.toolCallParser as never)) {
        return fail(`--tool-call-parser must be one of ${TOOL_CALL_PARSERS.join(', ')}`)
      }
      const generationPath = normalizeGenerationPathFlag(opts.generationPath)
      if (opts.generationPath != null && !generationPath) {
        return fail(`--generation-path must be one of ${GENERATION_PATH_MODES.join(', ')}`)
      }
      const reasoningEffort = normalizeReasoningEffortFlag(opts.reasoningEffort)
      if (opts.reasoningEffort != null && !reasoningEffort) {
        return fail(`--reasoning-effort must be one of ${REASONING_EFFORTS.join(', ')}`)
      }
      let apiKey = opts.key
      if ((opts.auth === 'bearer' || opts.auth === 'api-key') && !apiKey) {
        const reg = await apiFetch<RegistryResponse>('GET', '/api/routing/registry')
        const hasExistingSecret = reg.secretRefs.includes(providerSecretRef(id))
        if (!hasExistingSecret) {
          apiKey = await promptSecret(`API key for ${id}: `)
          if (!apiKey) return fail('an API key is required for this auth kind')
        }
      }
      await apiFetch('POST', '/api/routing/provider', {
        id,
        baseUrl: opts.baseUrl,
        api: opts.api,
        authKind: opts.auth,
        ...(opts.header ? { authHeader: opts.header } : {}),
        ...(opts.label ? { label: opts.label } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(generationPath ? { generationPath } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(opts.toolCallParser ? { toolCallParser: opts.toolCallParser } : {}),
      })
      logger.print(`✓ provider ${id} registered`)
    }),
  )

const providerRm = new Command('rm')
  .description('Remove a provider and its models.')
  .argument('<id>', 'provider id')
  .action((id: string) =>
    run(async () => {
      await apiFetch('DELETE', `/api/routing/provider?id=${encodeURIComponent(id)}`)
      logger.print(`✓ provider ${id} removed`)
    }),
  )

const providerList = new Command('list').description('List registered providers.').action(() =>
  run(async () => {
    const reg = await apiFetch<RegistryResponse>('GET', '/api/routing/registry')
    if (reg.providers.length === 0) {
      logger.print('No providers.')
      return
    }
    for (const p of reg.providers) {
      const path = `path=${p.generationPath ?? 'versioned'}`
      const effort = p.reasoningEffort ? ` effort=${p.reasoningEffort}` : ''
      const parser = p.toolCallParser ? ` tool-parser=${p.toolCallParser}` : ''
      logger.print(
        `  ${p.id.padEnd(20)} ${p.api.padEnd(20)} ${path.padEnd(14)}${effort.padEnd(14)} ${p.auth.kind.padEnd(12)} ${p.origin.padEnd(8)}${parser} ${p.baseUrl}`,
      )
    }
  }),
)

const providerCmd = new Command('provider')
  .description('Manage model providers.')
  .addCommand(providerAdd)
  .addCommand(providerRm)
  .addCommand(providerList)

// ── model rm (mounted under `afw model`) ──────────────────────

const modelRm = new Command('rm')
  .description('Remove a model.')
  .argument('<id>', 'model id')
  .action((id: string) =>
    run(async () => {
      await apiFetch('DELETE', `/api/routing/model?id=${encodeURIComponent(id)}`)
      logger.print(`✓ model ${id} removed`)
    }),
  )

type ModelSetOpts = {
  provider?: string
  reasoningEffort?: string
  clearReasoningEffort?: boolean
}

const modelSet = new Command('set')
  .description('Update model routing metadata.')
  .argument('<id>', 'model id')
  .option('--provider <id>', 'disambiguate provider id')
  .option('--reasoning-effort <effort>', `model reasoning effort: ${REASONING_EFFORTS.join(' | ')}`)
  .option('--clear-reasoning-effort', 'clear the model reasoning effort override')
  .action((id: string, opts: ModelSetOpts) =>
    run(async () => {
      const wantsEffort = opts.reasoningEffort != null
      const wantsClear = opts.clearReasoningEffort === true
      if (wantsEffort === wantsClear) {
        return fail('pass exactly one of --reasoning-effort or --clear-reasoning-effort')
      }
      const effort = normalizeReasoningEffortFlag(opts.reasoningEffort)
      if (wantsEffort && !effort) {
        return fail(`--reasoning-effort must be one of ${REASONING_EFFORTS.join(', ')}`)
      }

      const reg = await apiFetch<RegistryResponse>('GET', '/api/routing/registry')
      const matches = reg.models.filter(
        (m) => m.id === id && (!opts.provider || m.providerId === opts.provider),
      )
      if (matches.length === 0) {
        const suffix = opts.provider ? ` under provider "${opts.provider}"` : ''
        return fail(`unknown model "${id}"${suffix}`)
      }
      if (matches.length > 1) {
        return fail(
          `model "${id}" exists under multiple providers: ${matches.map((m) => m.providerId).join(', ')}; pass --provider`,
        )
      }

      const model = matches[0]!
      await apiFetch('POST', '/api/routing/model', {
        id: model.id,
        providerId: model.providerId,
        label: model.label,
        ...(model.api ? { api: model.api } : {}),
        input: model.input,
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
        ...(model.cost ? { cost: model.cost } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      })
      logger.print(
        `✓ model ${model.providerId}/${model.id} reasoning effort → ${effort ?? 'provider default'}`,
      )
    }),
  )

// ── route secret ──────────────────────────────────────────────────

const secretSet = new Command('set')
  .description('Store a secret value under a ref (prompted, no echo).')
  .argument('<ref>', 'secret ref, e.g. provider:my-provider')
  .action((ref: string) =>
    run(async () => {
      const value = await promptSecret(`Value for ${ref}: `)
      if (!value) return fail('no value entered')
      await apiFetch('POST', '/api/routing/secret', { ref, value })
      logger.print(`✓ secret ${ref} stored`)
    }),
  )

const secretRm = new Command('rm')
  .description('Remove a secret.')
  .argument('<ref>', 'secret ref')
  .action((ref: string) =>
    run(async () => {
      await apiFetch('DELETE', `/api/routing/secret?ref=${encodeURIComponent(ref)}`)
      logger.print(`✓ secret ${ref} removed`)
    }),
  )

const secretList = new Command('list')
  .description('List the refs of stored secrets — values are never shown.')
  .action(() =>
    run(async () => {
      const reg = await apiFetch<RegistryResponse>('GET', '/api/routing/registry')
      if (reg.secretRefs.length === 0) {
        logger.print('No secrets.')
        return
      }
      for (const ref of reg.secretRefs) logger.print(`  ${ref}`)
    }),
  )

const secretCmd = new Command('secret')
  .description('Manage API-key secrets (write-only — values never leave the daemon).')
  .addCommand(secretSet)
  .addCommand(secretRm)
  .addCommand(secretList)

// ── route subagent (Claude Code subagent downgrade) ───────────────

const subagentCmd = new Command('subagent')
  .description(
    'Subagent downgrade: route Claude Code dynamic-workflow subagents to a ' +
      'cheaper model while the planner stays on its model (default on).',
  )
  .option('--on', 'enable subagent downgrade')
  .option('--off', 'disable it — every subagent runs on its requested model')
  .option('--model <id>', 'the model subagent calls are routed to')
  .option('--floor <maxTokens>', 'skip utility calls below this max_tokens')
  .action((opts: { on?: boolean; off?: boolean; model?: string; floor?: string }) =>
    run(async () => {
      const cur = effectiveSubagentDowngrade(await readRoutingPolicy())
      const wantsChange = opts.on || opts.off || opts.model != null || opts.floor != null
      if (!wantsChange) {
        logger.print('Claude Code subagent downgrade')
        logger.print(`  status : ${cur.enabled ? 'ON' : 'off'}`)
        logger.print(`  target : ${cur.modelId}`)
        logger.print(`  floor  : skip calls under ${cur.minMaxTokens} max_tokens`)
        logger.print('')
        logger.print('  Planner calls (those carrying the Agent tool) are never downgraded.')
        logger.print('  afw route subagent --off          disable')
        logger.print('  afw route subagent --model <id>   retarget')
        return
      }
      if (opts.on && opts.off) throw new Error('pass only one of --on / --off')
      const next = { ...cur }
      if (opts.on) next.enabled = true
      if (opts.off) next.enabled = false
      if (opts.model != null) {
        if (opts.model === '') throw new Error('--model needs a model id')
        next.modelId = opts.model
      }
      if (opts.floor != null) {
        const n = Number.parseInt(opts.floor, 10)
        if (!Number.isFinite(n) || n < 0) {
          throw new Error('--floor needs a non-negative integer')
        }
        next.minMaxTokens = n
      }
      await mutateRoutingPolicy((p) => ({ ...p, subagentDowngrade: next }))
      logger.print(
        `subagent downgrade ${next.enabled ? 'ON' : 'off'} → ${next.modelId} (floor ${next.minMaxTokens})`,
      )
    }),
  )

// ── route ─────────────────────────────────────────────────────────
//
// `route` is purely about routing decisions. Provider / model / secret
// registry management lives under `afw model` — the CRUD command
// objects are defined above and re-exported for that command to mount.

export const routeCommand = new Command('route')
  .description(
    'Configure per-agent model routing: single models, failover chains, Model Fusion, vision companions, and subagent downgrade.',
  )
  .addCommand(subagentCmd)
  .addCommand(listCmd)
  .addCommand(showCmd)
  .addCommand(setCmd)
  .addCommand(unsetCmd)
  .addCommand(visionCmd)
  .addCommand(fusionCmd)

// Mounted under `afw model` (see commands/model.ts) so there's one home
// for "what models exist" separate from "where traffic goes".
export { providerCmd, secretCmd, modelRm, modelSet }
