// Defensive accessors shared by the protocol translators. Every translator
// input is untrusted third-party JSON, so each field read is guarded.

// biome-ignore lint/suspicious/noExplicitAny: third-party JSON payloads.
export type Any = any

export function asObject(v: unknown): Any {
  return v != null && typeof v === 'object' ? (v as Any) : {}
}

/** A non-empty string, or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** A finite number, or the fallback (default 0). */
export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** A finite number, or undefined. */
export function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Parse a tool-call `arguments` value: a JSON string, an object, or absent. */
export function parseToolArgs(raw: unknown): unknown {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** Serialize a tool-call input back to the JSON-string form OpenAI expects. */
export function stringifyToolArgs(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

// ── freeform (OpenAI `custom`) tools ──────────────────────────────
//
// A `custom` tool (codex's `apply_patch`) is called with a single raw-text
// payload, not JSON arguments — often carrying a Lark grammar. Routed models
// that only speak JSON/native tool calls can't express that, so afw exposes a
// freeform tool as an ordinary function with one `input` string arg (the whole
// payload verbatim) and folds the grammar into the description. The response
// side turns the model's `{input: "…"}` call back into the `custom_tool_call`
// the client registered.

export const FREEFORM_ARG = 'input'

/** The function-tool schema a freeform tool is exposed as: one required
 *  `input` string carrying the entire payload verbatim. */
export function freeformFunctionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      [FREEFORM_ARG]: {
        type: 'string',
        description: 'The complete tool payload, verbatim — a raw string, not wrapped in JSON.',
      },
    },
    required: [FREEFORM_ARG],
  }
}

/** The JSON schema to advertise for an IR tool: freeform tools get the
 *  single-`input`-string schema; everything else keeps its own. */
export function effectiveToolSchema(t: {
  freeform?: boolean
  inputSchema: unknown
}): unknown {
  return t.freeform ? freeformFunctionSchema() : (t.inputSchema ?? { type: 'object' })
}

/** The description to advertise for an IR tool: freeform tools get their
 *  original description plus an explicit instruction to place the entire
 *  payload in `input`, plus the Lark grammar when present. */
export function effectiveToolDescription(t: {
  freeform?: boolean
  grammar?: string
  description?: string
}): string | undefined {
  if (!t.freeform) return t.description
  const parts = [t.description ?? '']
  parts.push(
    `This tool takes one argument, \`${FREEFORM_ARG}\`: a string holding the ENTIRE tool ` +
      'payload verbatim. Do not wrap the payload in JSON or split it across fields.',
  )
  if (t.grammar) parts.push(`The \`${FREEFORM_ARG}\` string must follow this Lark grammar:\n${t.grammar}`)
  return parts.filter((p) => p.length > 0).join('\n\n')
}

/** Recover the raw freeform payload string from a tool-call input. The model
 *  should have used `{input: "…"}`; tolerate a bare string or a stray key. */
export function freeformInputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 0) return ''
    if (typeof o[FREEFORM_ARG] === 'string') return o[FREEFORM_ARG] as string
    // A freeform call carries one payload; whatever key the model invented for
    // it (GLM tends to echo the grammar field name), take that single value.
    for (const v of Object.values(o)) if (typeof v === 'string') return v
  }
  return input == null ? '' : JSON.stringify(input)
}

// ── codex's `local_shell` built-in ────────────────────────────────
//
// Codex ships its shell capability as the OpenAI Responses *built-in*
// `local_shell` tool — `{type:"local_shell"}`, an object with a type but no
// `name`. Chat Completions has no built-in equivalent, so to route codex to a
// chat-completions backend we expose it as an ordinary function tool the model
// can call, and turn the model's call back into the `local_shell_call` item
// codex expects on the response. The shared name keeps that round-trip stable
// across the parser (from-openai-responses) and serializer (to-openai-responses).

export const LOCAL_SHELL_TOOL = 'local_shell'

/** Function-tool JSON schema mirroring `local_shell`'s exec action — an argv
 *  array plus the optional working-directory / timeout codex passes through. */
export const LOCAL_SHELL_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'array',
      items: { type: 'string' },
      description: 'The command to run as an argv array, e.g. ["bash","-lc","ls -la"].',
    },
    workdir: { type: 'string', description: 'Working directory for the command.' },
    timeout_ms: { type: 'number', description: 'Timeout in milliseconds.' },
  },
  required: ['command'],
} as const

/** A `local_shell_call` action → the function-call input we hand the chat
 *  backend. Keeps `command` plus whatever optional knobs were present. */
export function shellActionToInput(action: unknown): Record<string, unknown> {
  const a = asObject(action)
  const input: Record<string, unknown> = {}
  if (Array.isArray(a.command) || typeof a.command === 'string') input.command = a.command
  const workdir = a.workdir ?? a.working_directory
  if (typeof workdir === 'string') input.workdir = workdir
  if (typeof a.timeout_ms === 'number') input.timeout_ms = a.timeout_ms
  return input
}

/** The chat backend's function-call input → a `local_shell_call` exec action,
 *  the shape codex consumes. Tolerates a `command` given as a string. */
export function inputToShellAction(input: unknown): Record<string, unknown> {
  const i = typeof input === 'string' ? safeJson(input) : asObject(input)
  const command = Array.isArray(i.command)
    ? i.command
    : typeof i.command === 'string'
      ? ['bash', '-lc', i.command]
      : []
  const action: Record<string, unknown> = { type: 'exec', command }
  const workdir = i.workdir ?? i.working_directory
  if (typeof workdir === 'string') action.working_directory = workdir
  if (typeof i.timeout_ms === 'number') action.timeout_ms = i.timeout_ms
  return action
}

function safeJson(raw: string): Any {
  try {
    return asObject(JSON.parse(raw))
  } catch {
    return {}
  }
}
