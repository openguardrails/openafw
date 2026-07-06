// OpenAI Responses → neutral IR. The Responses request `input` is a flat item
// stream — `message`, `function_call`, `function_call_output` — which the IR
// folds back into user/assistant turns. Response output is parsed by the same
// `collectOutputBlocks` the Responses decoder already uses.

import { nanoid } from 'nanoid'
import type { NormalizedBlock } from '../../core/packet.ts'
import { collectOutputBlocks } from '../decoders/openai/responses-sse.ts'
import { extractInlineToolCallsXml } from './xml-tool-calls.ts'
import {
  type IRBlock,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRTool,
  mergeConsecutive,
  urlToImageSource,
} from './ir.ts'
import {
  FREEFORM_ARG,
  LOCAL_SHELL_SCHEMA,
  LOCAL_SHELL_TOOL,
  asObject,
  freeformInputText,
  num,
  optNum,
  parseToolArgs,
  shellActionToInput,
  str,
} from './shared.ts'

export function requestToIR(body: unknown): IRRequest {
  const b = asObject(body)
  const messages: IRMessage[] = []
  if (typeof b.input === 'string') {
    if (b.input.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: b.input }] })
    }
  } else if (Array.isArray(b.input)) {
    for (const raw of b.input) {
      const it = asObject(raw)
      if (it.type === 'function_call' || it.type === 'custom_tool_call') {
        // `custom_tool_call` is codex's freeform-tool call (e.g. apply_patch);
        // its payload lives in `input` as a raw string. Normalize it to the
        // `{input: "…"}` shape the exposed function tool uses, so it serializes
        // to the routed upstream as `arguments: {"input":"…"}`.
        const input =
          it.type === 'custom_tool_call'
            ? { [FREEFORM_ARG]: freeformInputText(it.input ?? it.arguments) }
            : parseToolArgs(it.arguments ?? it.input)
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: str(it.call_id) ?? str(it.id) ?? '',
              name: str(it.name) ?? '',
              input,
            },
          ],
        })
      } else if (it.type === 'local_shell_call') {
        // Codex's shell call — fold into a tool_use against the synthetic
        // `local_shell` function tool so the conversation history stays
        // consistent with the tool we expose to the chat backend.
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: str(it.call_id) ?? str(it.id) ?? '',
              name: LOCAL_SHELL_TOOL,
              input: shellActionToInput(it.action),
            },
          ],
        })
      } else if (
        it.type === 'function_call_output' ||
        it.type === 'tool_result' ||
        it.type === 'custom_tool_call_output' ||
        it.type === 'local_shell_call_output'
      ) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: str(it.call_id) ?? str(it.id) ?? '',
              content: [{ type: 'text', text: outputToText(it.output ?? it.content) }],
            },
          ],
        })
      } else if (it.type === 'message' || (it.role && it.content !== undefined)) {
        const role = it.role === 'assistant' ? 'assistant' : 'user'
        messages.push({ role, content: contentToBlocks(it.content) })
      }
    }
  }
  return {
    model: str(b.model) ?? '',
    system: str(b.instructions),
    messages: mergeConsecutive(messages),
    tools: toolsToIR(b.tools),
    maxTokens: optNum(b.max_output_tokens),
    temperature: optNum(b.temperature),
    stream: b.stream === true,
  }
}

export function responseToIR(json: unknown): IRResponse {
  const j = asObject(json)
  const usage = asObject(j.usage)
  const { blocks, promoted } = promoteInlineXmlToolCalls(collectOutputBlocks(j.output))
  return {
    model: str(j.model) ?? '',
    blocks,
    // A promoted XML tool call means the upstream reported `completed`
    // (it emitted the call as plain text, not a native function_call), so
    // carry the canonical tool-use stop reason instead of end_turn.
    stopReason: promoted ? 'tool_use' : statusToStopReason(j),
    usage: {
      in: num(usage.input_tokens ?? usage.prompt_tokens),
      out: num(usage.output_tokens ?? usage.completion_tokens),
      cacheRead: optNum(
        asObject(usage.input_tokens_details).cached_tokens ??
          asObject(usage.prompt_tokens_details).cached_tokens,
      ),
    },
  }
}

// ── helpers ───────────────────────────────────────────────────────

/** Some models routed behind a Responses endpoint emit tool calls as inline
 *  XML inside an assistant text block (GLM `<tool_call>name<arg_key>…`,
 *  Hermes `<tool_call>{json}`, Claude `<invoke>`) instead of a native
 *  `function_call` output item. Promote those into real tool_use blocks so
 *  the agent sees a tool call it can run, not inert text. Mirrors the same
 *  recovery `from-openai-chat.ts` does on the chat path. */
function promoteInlineXmlToolCalls(input: NormalizedBlock[]): {
  blocks: NormalizedBlock[]
  promoted: boolean
} {
  let promoted = false
  const blocks: NormalizedBlock[] = []
  for (const b of input) {
    if (b.type !== 'text' || b.text.length === 0) {
      blocks.push(b)
      continue
    }
    const parsed = extractInlineToolCallsXml(b.text)
    if (!parsed || parsed.toolUses.length === 0) {
      blocks.push(b)
      continue
    }
    promoted = true
    if (parsed.cleanedText.length > 0) blocks.push({ type: 'text', text: parsed.cleanedText })
    for (const tu of parsed.toolUses) {
      blocks.push({
        type: 'tool_use',
        // XML formats carry no call id; synthesize a GLOBALLY unique one. A
        // per-response counter (afw_xml_0, …) collides across turns — every
        // turn's single call becomes `afw_xml_0`, so a long multi-turn history
        // has one id shared by 100+ calls and the model can't tell its own
        // actions apart (it thrashes). nanoid keeps each call distinct.
        id: `afw_xml_${nanoid()}`,
        name: tu.name,
        input: tu.input,
        ...(tu.rawJson ? { rawJson: tu.rawJson } : {}),
      })
    }
  }
  return { blocks, promoted }
}

function statusToStopReason(j: Record<string, unknown>): string | undefined {
  const status = str(j.status)
  if (!status || status === 'completed' || status === 'in_progress') return undefined
  // `incomplete` on the Responses API means an output cap was hit.
  if (status === 'incomplete') return 'max_tokens'
  return status
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((p) => {
        const o = asObject(p)
        return typeof o.text === 'string' ? o.text : ''
      })
      .join('')
  }
  return ''
}

function contentToBlocks(content: unknown): IRBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: IRBlock[] = []
  for (const raw of content) {
    const p = asObject(raw)
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      blocks.push({ type: 'text', text: typeof p.text === 'string' ? p.text : '' })
    } else if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : str(asObject(p.image_url).url)
      if (url) blocks.push({ type: 'image', source: urlToImageSource(url) })
    }
  }
  return blocks
}

function toolsToIR(tools: unknown): IRTool[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const out: IRTool[] = []
  for (const raw of tools) {
    const t = asObject(raw)
    // Codex's `local_shell` built-in has a `type` but no `name`. Chat
    // Completions can't express a built-in, so surface it as a function tool
    // the routed model can actually call — otherwise the old `if (!name)`
    // guard dropped it silently and the model saw only codex's named tools
    // (apply_patch / update_plan), reporting it had no way to read or run.
    if (t.type === 'local_shell') {
      out.push({
        name: LOCAL_SHELL_TOOL,
        description:
          "Run a shell command on the user's machine and return its " +
          'stdout/stderr. Provide the command as an argv array.',
        inputSchema: LOCAL_SHELL_SCHEMA,
      })
      continue
    }
    // A `custom` tool (codex's apply_patch) is freeform: its call is a raw
    // string following an optional Lark grammar, not JSON arguments. Preserve
    // that so the serializers expose a single-`input` function to the routed
    // model and the response side hands it back as a `custom_tool_call`.
    if (t.type === 'custom') {
      const nm = str(t.name)
      if (!nm) continue
      const format = asObject(t.format)
      out.push({
        name: nm,
        description: str(t.description),
        inputSchema: { type: 'object' },
        freeform: true,
        ...(str(format.definition) ? { grammar: str(format.definition) } : {}),
      })
      continue
    }
    const fn = asObject(t.function)
    const name = str(t.name) ?? str(fn.name)
    if (!name) continue
    out.push({
      name,
      description: str(t.description) ?? str(fn.description),
      inputSchema: t.parameters ?? fn.parameters ?? { type: 'object' },
    })
  }
  return out.length > 0 ? out : undefined
}
