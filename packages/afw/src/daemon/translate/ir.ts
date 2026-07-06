// The neutral intermediate representation for protocol translation. Shaped
// after Anthropic Messages (the richest of the three wire formats), so the
// translation layer is 3 parsers + 3 serializers — not 6 pairwise conversions.
//
// A request becomes an IRRequest; a non-streaming response an IRResponse.
// IRResponse reuses the decoders' NormalizedBlock vocabulary so the response
// serializers and the capture pipeline speak the same types.

import type { NormalizedBlock } from '../../core/packet.ts'

/** Anthropic requires max_tokens; this is the fallback when a source request
 *  (OpenAI) omits it entirely. The orchestrator overrides with the target
 *  model's real limit when it knows it. */
export const DEFAULT_MAX_TOKENS = 4096

export type IRImageSource =
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'url'; url: string }

export type IRBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: IRImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: IRBlock[]; isError?: boolean }
  | { type: 'thinking'; text: string }

export type IRMessage = { role: 'user' | 'assistant'; content: IRBlock[] }

export type IRTool = {
  name: string
  description?: string
  inputSchema: unknown
  /** A freeform (OpenAI `custom`) tool: its call is a single raw-text payload,
   *  not JSON arguments. codex's `apply_patch` is the canonical case. Routed
   *  models that only speak JSON/native tool calls are given a function tool
   *  with one `input` string arg (see effectiveToolSchema); the response side
   *  emits the call back as a `custom_tool_call` the client registered. */
  freeform?: boolean
  /** Optional Lark grammar the freeform payload must follow — folded into the
   *  tool description so the routed model knows the exact syntax. */
  grammar?: string
}

/** How the model picks among available tools. Anthropic vocabulary:
 *    - `auto`       — model decides (or skips)
 *    - `any`        — must call some tool
 *    - `none`       — must not call any tool
 *    - `{tool,name}` — must call exactly this tool
 *  OpenAI's equivalents (`auto` / `required` / `none` / `{function,{name}}`)
 *  map 1-to-1 in the translators. Dropping this on cross-protocol
 *  routes silently breaks clients that *force* a tool call (e.g. Claude
 *  Code's WebSearchTool inner request) — the routed model just
 *  hallucinates instead of emitting tool_use. */
export type IRToolChoice =
  | { kind: 'auto' }
  | { kind: 'any' }
  | { kind: 'none' }
  | { kind: 'tool'; name: string }

export type IRRequest = {
  model: string
  system?: string
  messages: IRMessage[]
  tools?: IRTool[]
  toolChoice?: IRToolChoice
  maxTokens?: number
  temperature?: number
  stream: boolean
}

/** Canonical stop reasons, in Anthropic vocabulary. Unmapped upstream values
 *  are carried through verbatim as strings. */
export type IRStopReason = string

export type IRUsage = {
  in: number
  out: number
  cacheRead?: number
  cacheWrite?: number
}

export type IRResponse = {
  model: string
  blocks: NormalizedBlock[]
  stopReason?: IRStopReason
  usage: IRUsage
}

/** Merge adjacent messages of the same role — Anthropic expects alternating
 *  turns, and the OpenAI→IR parsers can emit consecutive user messages (a
 *  `tool` result message followed by a `user` message). */
export function mergeConsecutive(messages: IRMessage[]): IRMessage[] {
  const out: IRMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = [...last.content, ...m.content]
    } else {
      out.push({ role: m.role, content: [...m.content] })
    }
  }
  return out
}

// ── image source ↔ URL ────────────────────────────────────────────

/** Render an IR image source as a single URL string — the form OpenAI Chat
 *  (`image_url.url`) and OpenAI Responses (`input_image.image_url`) both use.
 *  base64 sources become a `data:` URI. */
export function imageSourceToUrl(src: IRImageSource): string {
  if (src.kind === 'url') return src.url
  return `data:${src.mediaType};base64,${src.data}`
}

/** Parse a URL string into an IR image source. `data:` URIs are decoded back
 *  to a base64 source; everything else is kept as a url source. */
export function urlToImageSource(url: string): IRImageSource {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma !== -1) {
      const meta = url.slice(5, comma)
      const mediaType = meta.split(';')[0] || 'image/png'
      return { kind: 'base64', mediaType, data: url.slice(comma + 1) }
    }
  }
  return { kind: 'url', url }
}

// ── stop-reason mapping ───────────────────────────────────────────

const OPENAI_TO_CANONICAL: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  function_call: 'tool_use',
  content_filter: 'end_turn',
}

const CANONICAL_TO_OPENAI: Record<string, string> = {
  end_turn: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  stop_sequence: 'stop',
}

export function canonicalStopReason(openaiFinish: string | undefined): string | undefined {
  if (!openaiFinish) return undefined
  return OPENAI_TO_CANONICAL[openaiFinish] ?? openaiFinish
}

export function openaiStopReason(canonical: string | undefined): string {
  if (!canonical) return 'stop'
  return CANONICAL_TO_OPENAI[canonical] ?? canonical
}
