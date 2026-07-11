// Inline-XML tool-call parsers.
//
// Some models emit tool calls as inline XML in the assistant's
// `content` string instead of populating the structured `tool_calls`
// field. Two conventions show up in the wild:
//
// 1) Hermes / Qwen style — JSON inside a <tool_call> wrapper.
//    Often nested under <tool_calls>:
//
//      <tool_calls>
//        <tool_call>{"name":"foo","arguments":{"x":1}}</tool_call>
//      </tool_calls>
//
//    Bare <tool_call>{"name":...}</tool_call> also seen.
//
// 2) Claude (Anthropic) function-call XML — pre-tool_use legacy shape
//    that some open-source models trained on Claude transcripts still
//    emit, occasionally wrapped in <function_calls>:
//
//      <function_calls>
//        <invoke name="view_image">
//          <parameter name="image_id">1</parameter>
//          <parameter name="question">describe this</parameter>
//        </invoke>
//      </function_calls>
//
// 3) GLM / ChatGLM style — the tool name is bare text right after the
//    <tool_call> open, then alternating <arg_key>/<arg_value> pairs
//    (no JSON, no name= attribute):
//
//      <tool_call>apply_patch
//        <arg_key>file</arg_key><arg_value>/tmp/x</arg_value>
//        <arg_key>content</arg_key><arg_value># hi</arg_value>
//      </tool_call>
//
// Either format is tolerated even when malformed (missing wrappers,
// duplicated open tags, empty wrappers) — better to surface zero
// tool_uses + cleaned text than leak raw XML to the agent.
//
// What's deferred:
//   - Triple-backtick code-fence variant (`​`​`tool_call ... `​`​`).
//   - Streaming reconstruction across SSE deltas — same translate gap,
//     but the user-visible failure modes (vision-loop iterations,
//     web_search emulation rounds, every buffered cross-protocol route)
//     all go through the buffered responseToIR path this fix covers.

export type XmlToolCallParse = {
  /** The original text with all XML tool-call markup stripped. */
  cleanedText: string
  /** Parsed tool-call payloads, in document order. */
  toolUses: Array<{ name: string; input: unknown; rawJson?: string }>
}

// ── unified entry point ───────────────────────────────────────────

const ANY_TAG_RE = /<(?:tool_calls?|toolcalls?|function_calls|invoke|tool_call|toolcall)\b/i

/** Run whichever parser the text shape matches. Returns null when no
 *  XML tool-call markup is present (caller treats the text as plain
 *  assistant content). Order of attempt:
 *    1. GLM <arg_key>/<arg_value> — checked first because a GLM call is
 *       wrapped in the same <tool_call> tag Hermes matches, but its body
 *       is bare-text-name + arg pairs (not JSON), so Hermes would strip
 *       the wrapper and yield zero calls.
 *    2. Hermes JSON-in-<tool_call> — strictest, most common with Qwen.
 *    3. Anthropic well-formed <invoke> blocks — strict closing required.
 *    4. Tolerant fallback — handles malformed / unterminated / mistagged
 *       calls (e.g. <tool_call name="x"><parameter>v</parameter> with
 *       no closing </tool_call>, duplicated openings, <toolcall>
 *       misspelling). The fallback is the one real models keep
 *       triggering once they get confused, so it's the safety net. */
export function extractInlineToolCallsXml(text: string): XmlToolCallParse | null {
  if (!ANY_TAG_RE.test(text)) return null

  const glm = extractGlmArgKvToolCalls(text)
  if (glm && glm.toolUses.length > 0) return glm

  const hermes = extractHermesToolCalls(text)
  if (hermes && hermes.toolUses.length > 0) return hermes

  const invoke = extractAnthropicInvokeToolCalls(text)
  if (invoke && invoke.toolUses.length > 0) return invoke

  const tolerant = extractTolerantNamedCalls(text)
  if (tolerant && tolerant.toolUses.length > 0) return tolerant

  // Nothing parseable — still strip whatever wrapper junk we matched
  // so the visible answer isn't a wall of broken XML.
  return tolerant ?? invoke ?? hermes
}

// ── Hermes / Qwen ─────────────────────────────────────────────────

const HERMES_OPENING_RE = /<tool_calls?>/i
const TOOL_CALL_BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi
const WRAPPER_STRIP_RE = /<\/?tool_calls?>/gi

export function extractHermesToolCalls(text: string): XmlToolCallParse | null {
  if (!HERMES_OPENING_RE.test(text)) return null

  const toolUses: XmlToolCallParse['toolUses'] = []
  let match: RegExpExecArray | null
  const re = new RegExp(TOOL_CALL_BLOCK_RE)
  while ((match = re.exec(text)) !== null) {
    const innerRaw = (match[1] ?? '').trim()
    if (!innerRaw) continue
    const parsed = parseHermesInner(innerRaw)
    if (parsed) toolUses.push(parsed)
  }

  const cleaned = stripTrim(text.replace(TOOL_CALL_BLOCK_RE, '').replace(WRAPPER_STRIP_RE, ''))

  return { cleanedText: cleaned, toolUses }
}

function parseHermesInner(
  inner: string,
): { name: string; input: unknown; rawJson?: string } | undefined {
  let obj: unknown
  try {
    obj = JSON.parse(inner)
  } catch {
    return undefined
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const o = obj as Record<string, unknown>
  if (typeof o.name !== 'string' || o.name.length === 0) return undefined

  const rawArgs = o.arguments
  let input: unknown
  let rawJson: string | undefined
  if (typeof rawArgs === 'string') {
    rawJson = rawArgs
    try {
      input = JSON.parse(rawArgs)
    } catch {
      input = rawArgs
    }
  } else {
    input = rawArgs ?? {}
  }
  return { name: o.name, input, ...(rawJson ? { rawJson } : {}) }
}

// ── GLM / ChatGLM <arg_key>/<arg_value> ───────────────────────────

const GLM_BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/gi
const GLM_PAIR_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi
const GLM_UNCLOSED_JS_CALL_RE = /<tool_call>\s*([A-Za-z_][\w.:-]*)\s*\(\s*(\{[\s\S]*\})\s*\)\s*$/i
const GLM_UNCLOSED_BARE_RE = /<tool_call>\s*([A-Za-z_][\w.:-]*)\s*$/i

/** A `<tool_call>` block is GLM-shaped (not Hermes) when its body is bare
 *  text — a tool name followed by optional `<arg_key>/<arg_value>` pairs —
 *  rather than a JSON object. `{`-leading bodies are left for the Hermes
 *  parser. This also catches the degenerate `<tool_call>name</tool_call>`
 *  (no args) a confused model emits, so it becomes a real (empty) tool call
 *  the agent can error-and-retry on, not raw XML leaking into the transcript. */
function isGlmBody(inner: string): boolean {
  return !inner.trim().startsWith('{')
}

export function extractGlmArgKvToolCalls(text: string): XmlToolCallParse | null {
  const toolUses: XmlToolCallParse['toolUses'] = []
  let matchedGlmBlock = false
  const blockRe = new RegExp(GLM_BLOCK_RE)
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(text)) !== null) {
    const inner = block[1] ?? ''
    if (!isGlmBody(inner)) continue
    const call = parseGlmInner(inner)
    if (call) {
      matchedGlmBlock = true
      toolUses.push(call)
    }
  }
  const unclosedJsCall = text.match(GLM_UNCLOSED_JS_CALL_RE)
  if (unclosedJsCall?.[1] && unclosedJsCall[2]) {
    try {
      const input: unknown = JSON.parse(unclosedJsCall[2])
      matchedGlmBlock = true
      toolUses.push({ name: unclosedJsCall[1], input })
    } catch {
      // Leave malformed arguments as visible text so the model's prose is not
      // accidentally promoted into an executable tool call.
    }
  } else {
    const unclosedBare = text.match(GLM_UNCLOSED_BARE_RE)
    if (unclosedBare?.[1]) {
      matchedGlmBlock = true
      toolUses.push({ name: unclosedBare[1], input: {} })
    }
  }
  if (!matchedGlmBlock) return null

  // Strip only the GLM blocks we consumed; leave any JSON-style <tool_call>
  // for the Hermes parser.
  const cleaned = stripTrim(
    text
      .replace(GLM_BLOCK_RE, (m, inner: string) => (isGlmBody(inner) ? '' : m))
      .replace(GLM_UNCLOSED_JS_CALL_RE, '')
      .replace(GLM_UNCLOSED_BARE_RE, ''),
  )
  return { cleanedText: cleaned, toolUses }
}

function parseGlmInner(inner: string): { name: string; input: unknown } | undefined {
  const firstKey = inner.search(/<arg_key>/i)
  const name = (firstKey >= 0 ? inner.slice(0, firstKey) : inner).trim()
  if (!name) return undefined
  const input: Record<string, unknown> = {}
  const pairRe = new RegExp(GLM_PAIR_RE)
  let m: RegExpExecArray | null
  while ((m = pairRe.exec(inner)) !== null) {
    const key = (m[1] ?? '').trim()
    if (!key) continue
    input[key] = coerceParameter((m[2] ?? '').trim())
  }
  return { name, input }
}

// ── Anthropic <invoke> XML ────────────────────────────────────────

const INVOKE_OPENING_RE = /<invoke\b/i
// Greedy-non-greedy match catches one <invoke ...>...</invoke> per call.
// Malformed duplicated openings (model produces `<invoke name="x"><invoke
// name="x">...</invoke>` with one closer) get absorbed into the outer
// match's body — the inner <invoke> tag survives as text inside the
// body, which the parameter scan ignores. End result is one tool_use
// with the correct args, which is the right user intent.
const INVOKE_BLOCK_RE = /<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi
const PARAMETER_BLOCK_RE = /<parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi
const INVOKE_STRIP_RE = /<\/?(?:function_calls|invoke|parameter)\b[^>]*>/gi

export function extractAnthropicInvokeToolCalls(text: string): XmlToolCallParse | null {
  if (!INVOKE_OPENING_RE.test(text)) return null

  const toolUses: XmlToolCallParse['toolUses'] = []
  let match: RegExpExecArray | null
  const re = new RegExp(INVOKE_BLOCK_RE)
  while ((match = re.exec(text)) !== null) {
    const name = match[1]?.trim() ?? ''
    if (!name) continue
    const body = match[2] ?? ''
    const input = parseInvokeParameters(body)
    toolUses.push({ name, input })
  }

  const cleaned = stripTrim(
    text
      .replace(INVOKE_BLOCK_RE, '')
      // Any leftover bare tags from malformed nesting or trailing junk.
      .replace(INVOKE_STRIP_RE, ''),
  )

  return { cleanedText: cleaned, toolUses }
}

function parseInvokeParameters(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let m: RegExpExecArray | null
  const re = new RegExp(PARAMETER_BLOCK_RE)
  while ((m = re.exec(body)) !== null) {
    const name = m[1]?.trim() ?? ''
    if (!name) continue
    const raw = (m[2] ?? '').trim()
    out[name] = coerceParameter(raw)
  }
  return out
}

/** Parameter values are XML text — try to recover sensible JS types
 *  the way Claude's old function-call interpreter did. JSON objects /
 *  arrays / booleans / numbers parse out; anything else stays a
 *  string. Models that hint `string="true"` on the tag still get
 *  string-only behavior for that field because the regex captured
 *  raw value (no JSON parse if it's not JSON-shaped). */
function coerceParameter(raw: string): unknown {
  if (raw === '') return ''
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw)
    } catch {
      // fall through to string
    }
  }
  return raw
}

// ── tolerant fallback ─────────────────────────────────────────────
//
// When a confused model emits a malformed / unterminated tool-call
// (duplicated <invoke>/<tool_call> opens, no closer, misspelled tag
// like <toolcall>, name attribute on the wrong layer), neither strict
// parser matches. This fallback walks the text for *any* named
// opening tag and any <parameter> blocks, then synthesises one
// tool_use with the LAST named open's name + every parameter found.
// "Last open wins" because models that fumble the tag tend to
// self-correct toward the intended name late in the emission
// (`<toolcall name="viewimage"><tool_call name="view_image">` — the
// second one is what the model actually meant).

// Accept invoke, tool_call, toolcall (no underscore), or the
// containers tool_calls / toolcalls / function_calls as a "named open."
// We don't care which one — only the `name=` attribute matters.
const NAMED_OPEN_RE =
  /<(?:invoke|tool_calls?|toolcalls?|function_calls)\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi
const STRIP_ALL_XML_RE =
  /<\/?(?:invoke|tool_calls?|toolcalls?|function_calls|parameter)\b[^>]*>|<\/(?:invoke|tool_calls?|toolcalls?|function_calls|parameter)>/gi

function extractTolerantNamedCalls(text: string): XmlToolCallParse | null {
  const opens: Array<{ name: string; index: number }> = []
  let m: RegExpExecArray | null
  const openRe = new RegExp(NAMED_OPEN_RE)
  while ((m = openRe.exec(text)) !== null) {
    const name = m[1]?.trim()
    if (name) opens.push({ name, index: m.index })
  }
  if (opens.length === 0) return null

  // Pluck every <parameter name="X">value</parameter> in the text —
  // works for unclosed wrappers because <parameter> blocks are usually
  // closed even when their container isn't.
  const params: Array<{ name: string; value: string }> = []
  const pRe = new RegExp(PARAMETER_BLOCK_RE)
  while ((m = pRe.exec(text)) !== null) {
    const name = m[1]?.trim()
    if (!name) continue
    params.push({ name, value: (m[2] ?? '').trim() })
  }

  // Build one tool_use from the last named open + every parameter
  // found in the text. Multiple distinct tool calls in one malformed
  // emission is a v2 problem; in practice the failing real-world
  // payloads are single-tool confusion.
  const name = opens[opens.length - 1]?.name ?? ''
  const input: Record<string, unknown> = {}
  for (const p of params) input[p.name] = coerceParameter(p.value)

  // Cleaned text: strip every <parameter>…</parameter> block (whole
  // body) first so parameter values don't leak as text; then any
  // remaining open/close tags from unterminated containers.
  const cleaned = stripTrim(text.replace(PARAMETER_BLOCK_RE, '').replace(STRIP_ALL_XML_RE, ''))

  if (params.length === 0 && name === '') {
    return { cleanedText: cleaned, toolUses: [] }
  }
  return { cleanedText: cleaned, toolUses: name ? [{ name, input }] : [] }
}

// ── shared ────────────────────────────────────────────────────────

function stripTrim(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
