import type { AgentId } from './agent.ts'
import type { ActionId, RunId, ThreadId } from './ids.ts'
import type { ModelApi } from './model-registry.ts'
import type { DecoderKind } from './routes.ts'

export type Kind =
  | 'model_call'
  | 'tool_call'
  | 'mcp_call'
  | 'agent_call'
  | 'fs_op'
  | 'shell_exec'
  | 'memory_op'
  | 'network'

export type Cost = {
  usd: number
  tokensIn: number
  tokensOut: number
  tokensCacheRead?: number
  tokensCacheWrite?: number
  /** Dollars saved on this call by the subagent cost-saver: the cost the
   *  client-requested model would have run at, minus what the served (cheaper)
   *  model actually cost. Present only on a downgraded call. */
  savedUsd?: number
}

export type RiskTag = {
  tag: string
  severity: 'info' | 'warn' | 'high'
  detail?: unknown
}

export type NormalizedBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: unknown
      rawJson?: string
      /** True when this call targets a freeform (OpenAI `custom`) tool — the
       *  response encoders emit it as a `custom_tool_call` with a raw-string
       *  payload instead of a JSON-argument `function_call`. */
      freeform?: boolean
    }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'image'; source: unknown }
  | { type: 'unknown'; raw: unknown }

export type GuardEdit = {
  ruleId: string
  path: string
  role?: string
  before: string
  after: string
}

/** How a captured model_call was produced by the routing orchestrator.
 *  Absent on a plain passthrough call. */
export type Orchestration = {
  role:
    | 'parent'
    | 'primary'
    | 'failover'
    | 'budget-switch'
    | 'vision'
    | 'text-turn'
    // Fusion fan-out: each panel member, the judge, and the final synthesizer.
    | 'panel'
    | 'judge'
    | 'synthesis'
  /** The route's configured target — set on the parent of a fan-out.
   *  Legacy `'strategy'` / `'combo'` kinds stay readable so historically
   *  captured packets still parse. */
  configuredTarget?: {
    kind: 'model' | 'chain' | 'strategy' | 'combo' | 'passthrough'
    id: string
  }
  /** Position within a chain / vision loop — set on children. */
  step?: number
  /** Set when the request/response crossed a protocol boundary. */
  translated?: { from: ModelApi; to: ModelApi }
}

export type ModelCallPayload = {
  kind: 'model_call'
  protocol: DecoderKind
  endpoint: string
  /** The model the upstream actually saw (post-translation, post
   *  virtual-id swap, post routing-policy reroute). This is what the
   *  upstream billed, and what historical packets stored as `model`. */
  model: string
  /** The model the client *asked for* in its original `body.model`,
   *  before any afw-side swap. Differs from `model` when:
   *    • the route has a `sourceModelId` virtual-id swap (e.g.
   *      openclaw/hermes wrap routes);
   *    • the routing policy reroutes through the orchestrator (e.g.
   *      claude-desktop sends `claude-opus-4-7` and afw routes to
   *      `deepseek-v4-pro`).
   *  Equal to `model` for plain passthrough.
   *  Optional because packets captured before this field landed don't
   *  carry it. */
  clientModel?: string
  systemPrompt?: string
  messages: unknown[]
  tools?: unknown[]
  /** Generation parameters the request carried (temperature, max_tokens,
   *  top_p, reasoning effort, …) — everything but the message/tool content. */
  params?: Record<string, unknown>
  stream: boolean
  response: NormalizedBlock[]
  stopReason?: string
  status: number
  error?: string
  /** Upstream response headers captured when `status >= 400` — diagnostic
   *  detail that often disambiguates an opaque error body. Absent on
   *  successful calls. */
  errorHeaders?: Record<string, string>
  /** The provider this call actually hit. Pairs with `model` so the UI
   *  can render `provider/model` — necessary now that the same model id
   *  can exist under multiple providers (e.g. an `Xiangxin-2XL-Chat`
   *  harvested under hermes and added by hand under a custom provider).
   *  Optional because older captured packets don't carry it. */
  providerId?: string
  orchestration?: Orchestration
  guardEdits?: GuardEdit[]
}

export type NetworkPayload = {
  kind: 'network'
  protocol: DecoderKind
  endpoint: string
  method: string
  status: number
}

/** A tool executed locally by afw — today that's web_search emulation
 *  picking a configured backend (DuckDuckGo / Brave / SearXNG / Tavily)
 *  and running the query itself. Captured as a child of the routed
 *  model_call run so the dashboard can show "model called web_search,
 *  afw ran it via DDG" at a glance — without forcing the user to dig
 *  into the next-round messages.json. */
export type ToolCallPayload = {
  kind: 'tool_call'
  /** Tool name as the model called it (e.g. 'web_search'). */
  toolName: string
  /** ToolProvider id from ~/.afw/tool-providers.json. */
  providerId: string
  /** Backend implementation used (duckduckgo / brave / …). Surfaced
   *  alongside providerId so the UI can distinguish a user's
   *  custom-named provider from the underlying backend it routes to. */
  backend: string
  /** Whatever input the model passed — query, allowed_domains, etc. */
  input: unknown
  /** Top-line numeric outcome — for web_search this is hit count. */
  resultCount?: number
  /** Optional textual summary the dashboard surfaces inline. For
   *  web_search this is the first few hit titles + URLs so the user
   *  can see what the model got fed without expanding. */
  outputPreview?: string
  status: 'ok' | 'error'
  error?: string
}

export type McpCallPayload = {
  kind: 'mcp_call'
  protocol: DecoderKind
  server: string
  transport: 'stdio' | 'http' | 'sse'
  direction: 'request' | 'response' | 'notification'
  jsonrpcId?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export type AgentPacket = {
  id: ActionId
  runId: RunId
  threadId: ThreadId
  /** Truncated first user message of the conversation. The writer stores it
   *  as `threads.title` on first insert (first-writer-wins). Absent → title
   *  stays null. */
  threadTitle?: string
  /** Original wire bytes of the request/response, as captured before any
   *  normalization. The writer gzips these into action_payloads.raw_req /
   *  raw_res. They are the truth for `afw show --raw` and deterministic
   *  `afw replay`. Absent on paths that don't capture raw (orchestrator
   *  fan-out, passthrough). */
  rawReq?: Uint8Array
  rawRes?: Uint8Array
  /** Which running instance of `sourceAgent` produced this (a specific
   *  Claude Code window/session, an OpenClaw channel). Wire-derivable from
   *  the wrapper-model suffix, or back-filled by the session correlator.
   *  Null/absent = unknown or single-instance — degrades to the per-type view. */
  instanceId?: string
  /** Precise delegated sub-agent spawn id (set by the correlator). Distinct
   *  from the coarse sub-agent *type* tracked on outcomes.sub_agent. */
  subAgentId?: string
  parentActionId?: ActionId
  ts: number
  durMs: number
  sourceAgent: AgentId
  cost?: Cost
  risk?: RiskTag[]
  payload: ModelCallPayload | NetworkPayload | McpCallPayload | ToolCallPayload
}
