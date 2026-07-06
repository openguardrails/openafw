// Compatibility shims for upstreams that speak a session-bound dialect of
// an otherwise-standard wire API. Today: codex's ChatGPT backend
// (chatgpt.com/backend-api/codex). Tomorrow: Anthropic's claude-code path
// when more knobs surface.
//
// Ground truth for these shims is captured codex-CLI / claude-code traffic
// flowing through afw's own wire — not the public API reference.
// Whenever an off-agent route (openclaw, hermes, …) sends through one of
// these subscription backends, the request must match the first-party
// CLI's request shape or the upstream silently returns empty content
// (codex) / rate-limits hard (claude-code).
//
// Conventions:
//   • Each adapt* function takes the upstream body about to be POSTed and
//     mutates it in place. The caller passes the effective `reasoningEffort`
//     knob so a model-level override can drive both OpenAI Responses
//     `reasoning.effort` and claude-code's thinking budget.
//   • Predicates are URL-pattern matches; the host of an OAuth route is
//     pinned by the credential flow, so URL is a reliable discriminator.
//   • Defaults baked here mirror what each first-party CLI sends.
//     Adjusting them is fine when codex/claude-code change behavior — the
//     bundled catalog is the source of truth for capability, not these.

import type { ReasoningEffort } from '../../core/model-registry.ts'

// ── codex chatgpt backend ─────────────────────────────────────────

/** True when this is codex's ChatGPT session endpoint — same suffix used
 *  by generationUrl() to skip the /v1 segment. The host is fixed by the
 *  OAuth flow, so a path-suffix match is a reliable discriminator. */
export function isCodexChatGptBackend(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, '').endsWith('/backend-api/codex')
}

/** codex CLI's reasoning effort dial — OpenAI Responses doesn't expose the
 *  `xhigh` tier that Anthropic's thinking budget has, so we clamp it. */
const EFFORT_TO_CODEX: Record<ReasoningEffort, 'minimal' | 'low' | 'medium' | 'high'> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
}

/** Identity prompt the codex chatgpt backend's models (gpt-5.5 etc.) were
 *  trained against. Adapted from codex's own
 *  `protocol/src/prompts/base_instructions/default.md` — codex always sends
 *  a "You are a coding agent running in the Codex CLI" framing as its
 *  `instructions` field, and the codex-tuned models tend to fall back to
 *  reasoning-only (no message output) when they don't see that framing.
 *  Kept short on purpose: the source agent's own system prompt rides
 *  along as a developer-role message in `input[0]` (see below). */
const CODEX_IDENTITY_INSTRUCTIONS = `You are a coding agent running in the Codex CLI, a terminal-based coding assistant. You are expected to be precise, safe, and helpful.

The host harness provides your operating context — your specific role, available tools, and any constraints — as the first developer-role message in this turn. Treat that developer message as authoritative for your behavior in this session.

Use the tools provided by the harness to accomplish the user's task. Persist until the task is fully handled end-to-end within the current turn whenever feasible; do not stop at analysis or partial fixes. Stream concise thinking followed by direct, actionable output.`

/** Rewrite an openai-responses body to match codex's ChatGPT backend. The
 *  deltas were derived from captured codex-CLI requests:
 *
 *   • `store:false`             required — public default `true` is rejected
 *   • drop `max_output_tokens`   not accepted — server picks the cap
 *   • `reasoning.effort`         required for content — missing → empty SSE
 *   • `include: [reasoning…]`    codex CLI always asks for ciphertext
 *   • `text.verbosity:'low'`     codex CLI default — keeps output succinct
 *   • `tool_choice:'auto'`       fills the gap when the translator didn't
 *   • `parallel_tool_calls:true` codex CLI default
 *   • `instructions` reshape    codex-tuned models (gpt-5.5) expect a
 *     "You are a coding agent in the Codex CLI" framing in `instructions`
 *     and the harness-specific context as the first `developer`-role
 *     message in `input`. Without it the model reasons but returns no
 *     visible message blocks (observed: 26 reasoning tokens, 0 output).
 *
 *  The `prompt_cache_key` and `client_metadata.x-codex-installation-id`
 *  fields codex CLI sends are user-tracking identifiers — afw's privacy
 *  contract bans synthesizing them, so they stay off. Codex tolerates
 *  their absence (cache miss + uncategorized request, but the call works).
 */
export function adaptForCodexBackend(
  body: Record<string, unknown>,
  reasoningEffort: ReasoningEffort | undefined,
): void {
  body.store = false
  body.max_output_tokens = undefined

  const effort = EFFORT_TO_CODEX[reasoningEffort ?? 'medium']
  // Merge so a caller-supplied reasoning summary setting is preserved.
  const existingReasoning =
    typeof body.reasoning === 'object' && body.reasoning !== null
      ? (body.reasoning as Record<string, unknown>)
      : {}
  body.reasoning = { ...existingReasoning, effort }

  if (!Array.isArray(body.include)) {
    body.include = ['reasoning.encrypted_content']
  } else if (!body.include.includes('reasoning.encrypted_content')) {
    body.include = [...body.include, 'reasoning.encrypted_content']
  }

  const existingText =
    typeof body.text === 'object' && body.text !== null
      ? (body.text as Record<string, unknown>)
      : {}
  if (!('verbosity' in existingText)) {
    body.text = { ...existingText, verbosity: 'low' }
  }

  if (!('tool_choice' in body)) body.tool_choice = 'auto'
  if (!('parallel_tool_calls' in body)) body.parallel_tool_calls = true

  // Reshape the prompt structure: lift whatever the source agent put in
  // `instructions` to a developer-role message in `input[0]`, and stamp
  // codex's expected identity prompt into `instructions`. Idempotent —
  // skipped when the input already opens with a developer message (so a
  // direct codex-CLI request flowing through this adapter is a no-op).
  const sourceInstructions =
    typeof body.instructions === 'string' && body.instructions.trim() !== ''
      ? body.instructions
      : undefined
  const input = Array.isArray(body.input) ? body.input : []
  const opensWithDeveloper =
    input.length > 0 &&
    typeof input[0] === 'object' &&
    input[0] !== null &&
    (input[0] as Record<string, unknown>).type === 'message' &&
    (input[0] as Record<string, unknown>).role === 'developer'
  if (sourceInstructions && !opensWithDeveloper) {
    body.input = [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: sourceInstructions }],
      },
      ...input,
    ]
  }
  body.instructions = CODEX_IDENTITY_INSTRUCTIONS
}

/** Apply the public/OpenAI-compatible Responses reasoning knob without
 *  clobbering an explicit client-supplied `reasoning.effort`. Unlike the
 *  codex ChatGPT backend adapter, this does not clamp `xhigh`; third-party
 *  Responses-compatible gateways may support it even when OpenAI's public API
 *  does not. */
export function applyOpenAIResponsesReasoning(
  body: Record<string, unknown>,
  reasoningEffort: ReasoningEffort | undefined,
): boolean {
  if (!reasoningEffort) return false
  const existing =
    typeof body.reasoning === 'object' && body.reasoning !== null
      ? (body.reasoning as Record<string, unknown>)
      : {}
  if ('effort' in existing) return false
  body.reasoning = { ...existing, effort: reasoningEffort }
  return true
}

// ── self-hosted vLLM Responses backends ───────────────────────────

/** vLLM's Responses API rebuilds chat history from the request `input` items
 *  (`construct_chat_messages_with_tool_call`) and only handles `function_call`
 *  / `function_call_output` — it has no case for `custom_tool_call` /
 *  `custom_tool_call_output`, so it returns the raw item and the next
 *  iteration crashes on `prev_msg.get(...)`. When afw promotes a routed model's
 *  inline tool call into a `custom_tool_call` (so the agent that registered a
 *  freeform tool accepts it), the agent echoes that item back on the next turn
 *  — which would kill the vLLM endpoint. Downgrade those echoed history items
 *  to the `function_call` shapes vLLM does handle. The freeform tool itself is
 *  left untouched (the model calls it fine); only the history is rewritten. */
export function downgradeCustomToolCallsForResponses(body: Record<string, unknown>): void {
  const input = body.input
  if (!Array.isArray(input)) return
  let changed = false
  const rewritten = input.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw
    const it = raw as Record<string, unknown>
    if (it.type === 'custom_tool_call') {
      changed = true
      const payload = typeof it.input === 'string' ? it.input : JSON.stringify(it.input ?? '')
      return {
        type: 'function_call',
        call_id: it.call_id ?? it.id,
        name: it.name,
        arguments: JSON.stringify({ input: payload }),
      }
    }
    if (it.type === 'custom_tool_call_output') {
      changed = true
      return {
        type: 'function_call_output',
        call_id: it.call_id ?? it.id,
        output: it.output ?? it.content,
      }
    }
    return raw
  })
  if (changed) body.input = rewritten
}

// ── anthropic claude-code subscription ────────────────────────────

/** Anthropic's Messages thinking-budget tiers mapped from our shared
 *  effort knob. Values mirror Claude Code's documented presets (low /
 *  medium / high / "Ultrathink"); `minimal` falls back to the smallest
 *  budget Anthropic accepts. */
const EFFORT_TO_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 4096,
  medium: 16384,
  high: 32768,
  xhigh: 64000,
}

/** The exact identity string Claude Code CLI sends as its `system` field.
 *  Anthropic's subscription gate checks the system payload character-by-
 *  character: any deviation triggers "Third-party app" detection and
 *  routes the request to the user's extra-usage credit balance instead of
 *  their plan — typically 400'ing accounts that haven't topped up. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** Stringify whatever the IR translator wrote into `system` — either a
 *  plain string or an array of `{type:'text', text}` blocks — into a
 *  single text blob suitable for embedding into a user message. Anything
 *  not text-shaped is dropped. */
function collectSystemText(sys: unknown): string {
  if (typeof sys === 'string') return sys
  if (!Array.isArray(sys)) return ''
  const parts: string[] = []
  for (const b of sys) {
    if (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/** Adapt an anthropic-messages body for Claude Code's OAuth subscription.
 *
 *  Two things happen here that don't apply to api-key Anthropic provider:
 *
 *  1. `system` is overwritten with the literal Claude Code identity
 *     string. Anthropic's subscription gate inspects this field — any
 *     custom system prompt (even prepended with the identity) makes the
 *     server flag the call as "third-party app" and bill it to the
 *     extra-usage balance rather than the plan, which 400s when that
 *     balance is empty.
 *
 *  2. Whatever the source agent put in `system` (its own role / tooling
 *     context — e.g. openclaw's "You are a personal assistant…",
 *     codex's `instructions`, etc.) is lifted to a user-role message at
 *     the head of `messages`. That keeps the model aware of the source
 *     framing without leaking it into the gate-checked `system` slot.
 *
 *  Idempotent — re-running on a body whose `system` is already the
 *  literal Claude Code identity is a no-op.
 *
 *  Optionally injects a `thinking` config from the provider's
 *  reasoningEffort knob when the client didn't set one.
 */
export function adaptForClaudeCodeOAuth(
  body: Record<string, unknown>,
  reasoningEffort: ReasoningEffort | undefined,
): void {
  const sourceText = collectSystemText(body.system)
  const alreadyAdapted = sourceText === CLAUDE_CODE_IDENTITY
  if (!alreadyAdapted) {
    // Trim the Claude Code identity if a previous middleware (or a
    // re-run of this adapter on a half-adapted body) already prepended
    // it — we don't want to duplicate it in the user message.
    const sourceWithoutIdentity = sourceText.startsWith(CLAUDE_CODE_IDENTITY)
      ? sourceText.slice(CLAUDE_CODE_IDENTITY.length).replace(/^\n+/, '')
      : sourceText
    body.system = CLAUDE_CODE_IDENTITY
    if (sourceWithoutIdentity.trim() !== '') {
      const messages = Array.isArray(body.messages) ? body.messages : []
      body.messages = [
        {
          role: 'user',
          content: [{ type: 'text', text: sourceWithoutIdentity }],
        },
        ...messages,
      ]
    }
  }
  // Inject the reasoning-effort thinking budget when the client didn't
  // already specify one — same as before this adapter took on the
  // system-lift responsibility.
  if (reasoningEffort && (!('thinking' in body) || body.thinking == null)) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: EFFORT_TO_THINKING_BUDGET[reasoningEffort],
    }
  }
}
