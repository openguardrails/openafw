//! Streaming restore: an SSE reply rewritten frame by frame so a placeholder
//! restores even when it straddles two deltas. Unit of work is the FRAME
//! (an `event:` line precedes `data:` in Anthropic/Responses streams, and a
//! held tail flushed between them would be dispatched under the wrong name).
//!
//! Design §6.1: on the way back to the host EVERYTHING restores — text,
//! thinking and tool arguments alike. Each streamed field keeps its own tail.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::restore::{feed, restore, restore_value, tokens_in, Encode, Tail};
use crate::session::RestoreKeys;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    AnthropicMessages,
    OpenAiChat,
    OpenAiResponses,
    /// Google `generateContent` / `streamGenerateContent` (`alt=sse`).
    Gemini,
    /// Frames pass through untouched.
    Unknown,
}

impl Protocol {
    /// Which protocol a request path speaks. The path is enough for a local
    /// gateway: each agent is pointed at one prefix.
    pub fn from_path(path: &str) -> Protocol {
        let p = path.trim_end_matches('/');
        if p.contains(":generateContent") || p.contains(":streamGenerateContent") {
            Protocol::Gemini
        } else if p.ends_with("/v1/messages") || p.ends_with("/messages") {
            Protocol::AnthropicMessages
        } else if p.ends_with("/chat/completions") {
            Protocol::OpenAiChat
        } else if p.ends_with("/responses") {
            Protocol::OpenAiResponses
        } else {
            Protocol::Unknown
        }
    }
}

/// What one decoder makes of one `data:` payload.
struct Decoded {
    /// Complete frames to emit AHEAD of this one (held tails being flushed).
    before: String,
    /// The rewritten payload, or None when the frame passes through.
    payload: Option<String>,
}

trait FrameDecoder {
    fn data(&mut self, payload: &str, is_last: bool) -> Decoded;
    fn flush(&mut self) -> String;
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StreamReport {
    pub restored: usize,
    pub unresolved: Vec<String>,
}

impl StreamReport {
    fn note_unresolved(&mut self, keys: &RestoreKeys, seen: &str) {
        for t in tokens_in(seen) {
            if keys.value_of(&t).is_none() && !self.unresolved.contains(&t) {
                self.unresolved.push(t);
            }
        }
    }
}

fn parse(payload: &str) -> Option<Value> {
    serde_json::from_str::<Value>(payload).ok().filter(Value::is_object)
}

fn event_frame(name: &str, payload: &Value) -> String {
    format!("event: {name}\ndata: {payload}\n\n")
}

fn data_frame(payload: &Value) -> String {
    format!("data: {payload}\n\n")
}

// ---- anthropic.messages ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum AKind {
    Text,
    Thinking,
    Json,
}

impl AKind {
    fn delta_type(self) -> &'static str {
        match self {
            AKind::Text => "text_delta",
            AKind::Thinking => "thinking_delta",
            AKind::Json => "input_json_delta",
        }
    }
    fn field(self) -> &'static str {
        match self {
            AKind::Text => "text",
            AKind::Thinking => "thinking",
            AKind::Json => "partial_json",
        }
    }
    fn encode(self) -> Encode {
        match self {
            AKind::Json => Encode::JsonString,
            _ => Encode::Plain,
        }
    }
}

struct AnthropicDecoder<'k> {
    keys: &'k RestoreKeys,
    tails: BTreeMap<(u64, AKind), Tail>,
    report: StreamReport,
}

impl<'k> AnthropicDecoder<'k> {
    fn flush_block(&mut self, index: u64) -> String {
        let mut out = String::new();
        let kinds = [AKind::Text, AKind::Thinking, AKind::Json];
        for kind in kinds {
            let Some(tail) = self.tails.get_mut(&(index, kind)) else { continue };
            if !tail.pending.is_empty() {
                let pending = std::mem::take(&mut tail.pending);
                let payload = json!({
                    "type": "content_block_delta",
                    "index": index,
                    "delta": { "type": kind.delta_type(), kind.field(): pending }
                });
                out.push_str(&event_frame("content_block_delta", &payload));
                tail.seen.push_str(payload["delta"][kind.field()].as_str().unwrap_or(""));
            }
            let seen = std::mem::take(&mut tail.seen);
            self.report.note_unresolved(self.keys, &seen);
        }
        out
    }
}

impl<'k> FrameDecoder for AnthropicDecoder<'k> {
    fn data(&mut self, payload: &str, is_last: bool) -> Decoded {
        let none = Decoded { before: String::new(), payload: None };
        let Some(mut parsed) = parse(payload) else { return none };
        let index = parsed.get("index").and_then(Value::as_u64).unwrap_or(0);
        match parsed.get("type").and_then(Value::as_str) {
            Some("content_block_delta") => {
                let kind = match parsed.get("delta").and_then(|d| d.get("type")).and_then(Value::as_str) {
                    Some("text_delta") => AKind::Text,
                    Some("thinking_delta") => AKind::Thinking,
                    Some("input_json_delta") => AKind::Json,
                    _ => return none, // signature_delta and friends: never touched
                };
                let Some(original) = parsed["delta"].get(kind.field()).and_then(Value::as_str).map(str::to_string) else {
                    return none;
                };
                let tail = self.tails.entry((index, kind)).or_default();
                let before = tail.seen.len();
                let restored = feed(tail, &original, self.keys, kind.encode(), is_last);
                let _ = before;
                if restored == original {
                    return none;
                }
                self.report.restored += 1;
                parsed["delta"][kind.field()] = Value::String(restored);
                Decoded { before: String::new(), payload: Some(parsed.to_string()) }
            }
            Some("content_block_stop") => Decoded { before: self.flush_block(index), payload: None },
            Some("message_delta") | Some("message_stop") => Decoded { before: self.flush(), payload: None },
            _ => none,
        }
    }

    fn flush(&mut self) -> String {
        let indexes: Vec<u64> = self.tails.keys().map(|(i, _)| *i).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        let mut out = String::new();
        for i in indexes {
            out.push_str(&self.flush_block(i));
        }
        out
    }
}

// ---- openai.chat ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CKind {
    Content,
    Reasoning,
    Args,
}

struct ChatDecoder<'k> {
    keys: &'k RestoreKeys,
    /// (choice index, tool call index or 0, kind)
    tails: BTreeMap<(u64, u64, CKind), Tail>,
    model: String,
    report: StreamReport,
}

impl<'k> ChatDecoder<'k> {
    fn flush_choice(&mut self, choice: u64) -> String {
        let mut delta = serde_json::Map::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut any = false;
        for ((c, i, kind), tail) in self.tails.iter_mut() {
            if *c != choice {
                continue;
            }
            if !tail.pending.is_empty() {
                let pending = std::mem::take(&mut tail.pending);
                tail.seen.push_str(&pending);
                any = true;
                match kind {
                    CKind::Content => {
                        delta.insert("content".into(), Value::String(pending));
                    }
                    CKind::Reasoning => {
                        delta.insert("reasoning_content".into(), Value::String(pending));
                    }
                    CKind::Args => tool_calls.push(json!({ "index": i, "function": { "arguments": pending } })),
                }
            }
            let seen = std::mem::take(&mut tail.seen);
            self.report.note_unresolved(self.keys, &seen);
        }
        if !any {
            return String::new();
        }
        if !tool_calls.is_empty() {
            delta.insert("tool_calls".into(), Value::Array(tool_calls));
        }
        let mut chunk = json!({ "id": "chatcmpl-afw-flush", "object": "chat.completion.chunk",
            "choices": [{ "index": choice, "delta": Value::Object(delta) }] });
        if !self.model.is_empty() {
            chunk["model"] = Value::String(self.model.clone());
        }
        data_frame(&chunk)
    }
}

impl<'k> FrameDecoder for ChatDecoder<'k> {
    fn data(&mut self, payload: &str, is_last: bool) -> Decoded {
        let none = Decoded { before: String::new(), payload: None };
        if payload.trim() == "[DONE]" {
            return Decoded { before: self.flush(), payload: None };
        }
        let Some(mut parsed) = parse(payload) else { return none };
        if self.model.is_empty() {
            if let Some(m) = parsed.get("model").and_then(Value::as_str) {
                self.model = m.to_string();
            }
        }
        let Some(choices) = parsed.get_mut("choices").and_then(Value::as_array_mut) else { return none };
        let mut modified = false;
        let mut closing: Vec<u64> = Vec::new();
        for (ci, choice) in choices.iter_mut().enumerate() {
            let index = choice.get("index").and_then(Value::as_u64).unwrap_or(ci as u64);
            let closes = choice.get("finish_reason").map(Value::is_string).unwrap_or(false);
            let Some(delta) = choice.get_mut("delta").and_then(Value::as_object_mut) else {
                if closes {
                    closing.push(index);
                }
                continue;
            };
            for (field, kind) in [("content", CKind::Content), ("reasoning_content", CKind::Reasoning), ("reasoning", CKind::Reasoning)] {
                if let Some(original) = delta.get(field).and_then(Value::as_str).map(str::to_string) {
                    let tail = self.tails.entry((index, 0, kind)).or_default();
                    let restored = feed(tail, &original, self.keys, Encode::Plain, is_last || closes);
                    if restored != original {
                        self.report.restored += 1;
                        delta.insert(field.into(), Value::String(restored));
                        modified = true;
                    }
                }
            }
            if let Some(calls) = delta.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for (n, call) in calls.iter_mut().enumerate() {
                    let i = call.get("index").and_then(Value::as_u64).unwrap_or(n as u64);
                    let Some(original) = call.get("function").and_then(|f| f.get("arguments")).and_then(Value::as_str).map(str::to_string) else {
                        continue;
                    };
                    let tail = self.tails.entry((index, i, CKind::Args)).or_default();
                    let restored = feed(tail, &original, self.keys, Encode::JsonString, is_last || closes);
                    if restored != original {
                        self.report.restored += 1;
                        call["function"]["arguments"] = Value::String(restored);
                        modified = true;
                    }
                }
            }
            if closes {
                closing.push(index);
            }
        }
        let mut before = String::new();
        for c in closing {
            before.push_str(&self.flush_choice(c));
        }
        Decoded { before, payload: if modified { Some(parsed.to_string()) } else { None } }
    }

    fn flush(&mut self) -> String {
        let choices: Vec<u64> = self.tails.keys().map(|(c, _, _)| *c).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        let mut out = String::new();
        for c in choices {
            out.push_str(&self.flush_choice(c));
        }
        out
    }
}

// ---- openai.responses ------------------------------------------------------------

struct ResponsesDecoder<'k> {
    keys: &'k RestoreKeys,
    /// keyed by (output_index, event prefix e.g. "response.output_text")
    tails: BTreeMap<(u64, String), Tail>,
    report: StreamReport,
}

/// Streamed delta events: `<prefix>.delta` carries `delta`, and the held tail
/// is flushed under the SAME spelling. The JSON-text ones are tool arguments.
const RESPONSES_DELTA_PREFIXES: &[(&str, Encode)] = &[
    ("response.output_text", Encode::Plain),
    ("response.reasoning_text", Encode::Plain),
    ("response.reasoning_summary_text", Encode::Plain),
    ("response.function_call_arguments", Encode::JsonString),
    ("response.custom_tool_call_input", Encode::Plain),
];

impl<'k> ResponsesDecoder<'k> {
    fn flush_item(&mut self, index: u64) -> String {
        let mut out = String::new();
        let keys: Vec<(u64, String)> = self.tails.keys().filter(|(i, _)| *i == index).cloned().collect();
        for key in keys {
            let tail = self.tails.get_mut(&key).unwrap();
            if !tail.pending.is_empty() {
                let pending = std::mem::take(&mut tail.pending);
                tail.seen.push_str(&pending);
                let name = format!("{}.delta", key.1);
                out.push_str(&event_frame(&name, &json!({ "type": name, "output_index": index, "delta": pending })));
            }
            let seen = std::mem::take(&mut tail.seen);
            self.report.note_unresolved(self.keys, &seen);
        }
        out
    }

    fn whole(&mut self, holder: &mut Value, field: &str, how: Encode) -> bool {
        let Some(original) = holder.get(field).and_then(Value::as_str).map(str::to_string) else { return false };
        let r = restore(&original, self.keys, how);
        for t in r.unresolved {
            if !self.report.unresolved.contains(&t) {
                self.report.unresolved.push(t);
            }
        }
        if r.text == original {
            return false;
        }
        self.report.restored += r.restored;
        holder[field] = Value::String(r.text);
        true
    }

    /// A completed output ITEM, restored whole in place.
    fn whole_item(&mut self, item: &mut Value) -> bool {
        let mut changed = false;
        match item.get("type").and_then(Value::as_str) {
            Some("function_call") => changed |= self.whole(item, "arguments", Encode::JsonString),
            Some("custom_tool_call") => changed |= self.whole(item, "input", Encode::Plain),
            Some("message") | Some("reasoning") => {
                let fields: Vec<(&str, &str)> = vec![("content", "text"), ("summary", "text")];
                for (list, field) in fields {
                    if let Some(parts) = item.get_mut(list).and_then(Value::as_array_mut) {
                        for part in parts.iter_mut() {
                            changed |= self.whole(part, field, Encode::Plain);
                        }
                    }
                }
            }
            _ => {}
        }
        changed
    }
}

impl<'k> FrameDecoder for ResponsesDecoder<'k> {
    fn data(&mut self, payload: &str, is_last: bool) -> Decoded {
        let none = Decoded { before: String::new(), payload: None };
        let Some(mut parsed) = parse(payload) else { return none };
        let index = parsed.get("output_index").and_then(Value::as_u64).unwrap_or(0);
        let Some(ty) = parsed.get("type").and_then(Value::as_str).map(str::to_string) else { return none };
        for (prefix, how) in RESPONSES_DELTA_PREFIXES {
            if ty == format!("{prefix}.delta") {
                let Some(original) = parsed.get("delta").and_then(Value::as_str).map(str::to_string) else { return none };
                let tail = self.tails.entry((index, prefix.to_string())).or_default();
                let restored = feed(tail, &original, self.keys, *how, is_last);
                if restored == original {
                    return none;
                }
                self.report.restored += 1;
                parsed["delta"] = Value::String(restored);
                return Decoded { before: String::new(), payload: Some(parsed.to_string()) };
            }
            if ty == format!("{prefix}.done") {
                let before = self.flush_item(index);
                let field = match *prefix {
                    "response.function_call_arguments" => "arguments",
                    "response.custom_tool_call_input" => "input",
                    _ => "text",
                };
                let changed = self.whole(&mut parsed, field, *how);
                return Decoded { before, payload: if changed { Some(parsed.to_string()) } else { None } };
            }
        }
        match ty.as_str() {
            "response.output_item.done" => {
                let before = self.flush_item(index);
                let mut changed = false;
                if let Some(item) = parsed.get_mut("item") {
                    let mut it = item.take();
                    changed = self.whole_item(&mut it);
                    *item = it;
                }
                Decoded { before, payload: if changed { Some(parsed.to_string()) } else { None } }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                let before = self.flush();
                let mut changed = false;
                if let Some(output) = parsed.get_mut("response").and_then(|r| r.get_mut("output")).and_then(Value::as_array_mut) {
                    let mut items = std::mem::take(output);
                    for item in items.iter_mut() {
                        changed |= self.whole_item(item);
                    }
                    *output = items;
                }
                Decoded { before, payload: if changed { Some(parsed.to_string()) } else { None } }
            }
            _ => none,
        }
    }

    fn flush(&mut self) -> String {
        let indexes: Vec<u64> = self.tails.keys().map(|(i, _)| *i).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        let mut out = String::new();
        for i in indexes {
            out.push_str(&self.flush_item(i));
        }
        out
    }
}


// ---- gemini -------------------------------------------------------------------------

/// `candidates[].content.parts[]`: text parts are a delta stream per
/// candidate; `functionCall.args` arrive whole and are restored as a value.
struct GeminiDecoder<'k> {
    keys: &'k RestoreKeys,
    tails: BTreeMap<u64, Tail>,
    report: StreamReport,
}

impl<'k> GeminiDecoder<'k> {
    fn flush_candidate(&mut self, index: u64) -> String {
        let Some(tail) = self.tails.get_mut(&index) else { return String::new() };
        let mut out = String::new();
        if !tail.pending.is_empty() {
            let pending = std::mem::take(&mut tail.pending);
            tail.seen.push_str(&pending);
            out = data_frame(&json!({ "candidates": [{ "index": index, "content": { "role": "model", "parts": [{ "text": pending }] } }] }));
        }
        let seen = std::mem::take(&mut tail.seen);
        self.report.note_unresolved(self.keys, &seen);
        out
    }
}

impl<'k> FrameDecoder for GeminiDecoder<'k> {
    fn data(&mut self, payload: &str, is_last: bool) -> Decoded {
        let none = Decoded { before: String::new(), payload: None };
        let Some(mut parsed) = parse(payload) else { return none };
        let Some(candidates) = parsed.get_mut("candidates").and_then(Value::as_array_mut) else { return none };
        let mut modified = false;
        let mut closing: Vec<u64> = Vec::new();
        for (ci, cand) in candidates.iter_mut().enumerate() {
            let index = cand.get("index").and_then(Value::as_u64).unwrap_or(ci as u64);
            let closes = cand.get("finishReason").map(Value::is_string).unwrap_or(false);
            if let Some(parts) = cand.get_mut("content").and_then(|c| c.get_mut("parts")).and_then(Value::as_array_mut) {
                let last = parts.len().saturating_sub(1);
                for (pi, part) in parts.iter_mut().enumerate() {
                    if let Some(original) = part.get("text").and_then(Value::as_str).map(str::to_string) {
                        let tail = self.tails.entry(index).or_default();
                        // Only the LAST text part of a frame may straddle into the next frame.
                        let restored = feed(tail, &original, self.keys, Encode::Plain, is_last || closes || pi != last);
                        if restored != original {
                            self.report.restored += 1;
                            part["text"] = Value::String(restored);
                            modified = true;
                        }
                    } else if let Some(args) = part.get_mut("functionCall").and_then(|f| f.get_mut("args")) {
                        let r = restore_value(args, self.keys);
                        for t in r.unresolved {
                            if !self.report.unresolved.contains(&t) {
                                self.report.unresolved.push(t);
                            }
                        }
                        if r.changed {
                            self.report.restored += r.restored;
                            modified = true;
                        }
                    }
                }
            }
            if closes {
                closing.push(index);
            }
        }
        let mut before = String::new();
        for c in closing {
            before.push_str(&self.flush_candidate(c));
        }
        Decoded { before, payload: if modified { Some(parsed.to_string()) } else { None } }
    }

    fn flush(&mut self) -> String {
        let indexes: Vec<u64> = self.tails.keys().copied().collect();
        let mut out = String::new();
        for i in indexes {
            out.push_str(&self.flush_candidate(i));
        }
        out
    }
}

struct PassThrough;
impl FrameDecoder for PassThrough {
    fn data(&mut self, _payload: &str, _is_last: bool) -> Decoded {
        Decoded { before: String::new(), payload: None }
    }
    fn flush(&mut self) -> String {
        String::new()
    }
}

// ---- the frame loop ---------------------------------------------------------------

static FRAME_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n\r?\n").unwrap());

/// The stream rewriter for one protocol and one restore scope. Chunk
/// boundaries fall anywhere; nothing is parsed until a frame is whole. A
/// frame with exactly one `data:` line is decoded; anything else passes
/// through byte-identical.
pub struct Stream<'k> {
    kind: Protocol,
    keys: &'k RestoreKeys,
    anthropic: Option<AnthropicDecoder<'k>>,
    chat: Option<ChatDecoder<'k>>,
    responses: Option<ResponsesDecoder<'k>>,
    gemini: Option<GeminiDecoder<'k>>,
    pass: PassThrough,
    carry: String,
}

impl<'k> Stream<'k> {
    pub fn new(protocol: Protocol, keys: &'k RestoreKeys) -> Self {
        let mut s = Stream { kind: protocol, keys, anthropic: None, chat: None, responses: None, gemini: None, pass: PassThrough, carry: String::new() };
        match protocol {
            Protocol::AnthropicMessages => {
                s.anthropic = Some(AnthropicDecoder { keys, tails: BTreeMap::new(), report: StreamReport::default() })
            }
            Protocol::OpenAiChat => {
                s.chat = Some(ChatDecoder { keys, tails: BTreeMap::new(), model: String::new(), report: StreamReport::default() })
            }
            Protocol::OpenAiResponses => {
                s.responses = Some(ResponsesDecoder { keys, tails: BTreeMap::new(), report: StreamReport::default() })
            }
            Protocol::Gemini => s.gemini = Some(GeminiDecoder { keys, tails: BTreeMap::new(), report: StreamReport::default() }),
            Protocol::Unknown => {}
        }
        s
    }

    fn decoder(&mut self) -> &mut dyn FrameDecoder {
        if let Some(d) = self.anthropic.as_mut() {
            return d;
        }
        if let Some(d) = self.chat.as_mut() {
            return d;
        }
        if let Some(d) = self.responses.as_mut() {
            return d;
        }
        if let Some(d) = self.gemini.as_mut() {
            return d;
        }
        &mut self.pass
    }

    pub fn protocol(&self) -> Protocol {
        self.kind
    }

    pub fn report(&self) -> StreamReport {
        if let Some(d) = &self.anthropic {
            return d.report.clone();
        }
        if let Some(d) = &self.chat {
            return d.report.clone();
        }
        if let Some(d) = &self.responses {
            return d.report.clone();
        }
        if let Some(d) = &self.gemini {
            return d.report.clone();
        }
        StreamReport::default()
    }

    /// Nothing to restore: the caller may skip the rewrite entirely.
    pub fn inert(&self) -> bool {
        self.keys.is_empty() || self.kind == Protocol::Unknown
    }

    fn frame(&mut self, text: &str, is_last: bool) -> String {
        // Split keeping each line's own ending.
        let mut lines: Vec<&str> = Vec::new();
        let mut start = 0;
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                lines.push(&text[start..=i]);
                start = i + 1;
            }
        }
        if start < text.len() {
            lines.push(&text[start..]);
        }
        let data_lines: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.starts_with("data:")).map(|(i, _)| i).collect();
        if data_lines.len() != 1 {
            return text.to_string();
        }
        let at = data_lines[0];
        let line = lines[at];
        let ending = if line.ends_with("\r\n") {
            "\r\n"
        } else if line.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        let mut payload = &line[5..line.len() - ending.len()];
        if let Some(p) = payload.strip_prefix(' ') {
            payload = p;
        }
        let out = self.decoder().data(payload, is_last);
        let mut result = out.before;
        for (i, l) in lines.iter().enumerate() {
            if i == at {
                match &out.payload {
                    Some(p) => {
                        result.push_str("data: ");
                        result.push_str(p);
                        result.push_str(ending);
                    }
                    None => result.push_str(l),
                }
            } else {
                result.push_str(l);
            }
        }
        result
    }

    /// Feed raw stream text (any chunking); returns what may be emitted now.
    pub fn feed(&mut self, chunk: &str) -> String {
        self.carry.push_str(chunk);
        let mut out = String::new();
        loop {
            let Some(m) = FRAME_END.find(&self.carry) else { break };
            let end = m.end();
            let frame: String = self.carry[..end].to_string();
            self.carry.drain(..end);
            out.push_str(&self.frame(&frame, false));
        }
        out
    }

    /// The stream ended: the carried partial frame and every held tail.
    pub fn end(&mut self) -> String {
        let mut out = String::new();
        if !self.carry.is_empty() {
            let rest = std::mem::take(&mut self.carry);
            out.push_str(&self.frame(&rest, true));
        }
        out.push_str(&self.decoder().flush());
        out
    }
}
