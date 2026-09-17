//! Reassemble a streamed reply into the complete provider response body —
//! what `step/response` carries to an OGR runtime ("stream-reassembled if it
//! was streamed"). Fed the same raw SSE text the client receives (masked form,
//! before restoration), frame by frame; `finish()` yields one JSON object.

use serde_json::{json, Map, Value};

use crate::sse::Protocol;

#[derive(Debug, Default)]
pub struct Reassembler {
    protocol: Option<Protocol>,
    carry: String,
    // anthropic
    message: Option<Value>,
    blocks: Vec<Value>,
    partial_json: Vec<String>,
    // openai.chat
    chat_head: Option<Value>,
    chat_choices: Map<String, Value>, // index -> {role, content, reasoning_content, tool_calls{index->..}, finish_reason}
    // openai.responses
    responses_final: Option<Value>,
    // gemini
    gemini_candidates: Map<String, Value>,
    gemini_head: Option<Value>,
    pub frames: usize,
}

impl Reassembler {
    pub fn new(protocol: Protocol) -> Self {
        Self { protocol: Some(protocol), ..Default::default() }
    }

    pub fn feed(&mut self, chunk: &str) {
        self.carry.push_str(chunk);
        loop {
            let Some(pos) = find_frame_end(&self.carry) else { break };
            let frame: String = self.carry[..pos.1].to_string();
            self.carry.drain(..pos.1);
            self.frame(&frame);
        }
    }

    fn frame(&mut self, frame: &str) {
        let mut payload: Option<String> = None;
        for line in frame.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                let rest = rest.strip_prefix(' ').unwrap_or(rest);
                payload = Some(match payload {
                    Some(p) => format!("{p}\n{rest}"),
                    None => rest.to_string(),
                });
            }
        }
        let Some(p) = payload else { return };
        if p.trim() == "[DONE]" {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(&p) else { return };
        self.frames += 1;
        match self.protocol {
            Some(Protocol::AnthropicMessages) => self.anthropic(v),
            Some(Protocol::OpenAiChat) => self.chat(v),
            Some(Protocol::OpenAiResponses) => self.responses(v),
            Some(Protocol::Gemini) => self.gemini(v),
            _ => {}
        }
    }

    fn anthropic(&mut self, v: Value) {
        match v.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                self.message = v.get("message").cloned();
            }
            Some("content_block_start") => {
                let index = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                while self.blocks.len() <= index {
                    self.blocks.push(Value::Null);
                    self.partial_json.push(String::new());
                }
                self.blocks[index] = v.get("content_block").cloned().unwrap_or(Value::Null);
            }
            Some("content_block_delta") => {
                let index = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if index >= self.blocks.len() {
                    return;
                }
                let Some(delta) = v.get("delta") else { return };
                let block = &mut self.blocks[index];
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => append(block, "text", delta.get("text")),
                    Some("thinking_delta") => append(block, "thinking", delta.get("thinking")),
                    Some("signature_delta") => append(block, "signature", delta.get("signature")),
                    Some("input_json_delta") => {
                        if let Some(s) = delta.get("partial_json").and_then(Value::as_str) {
                            self.partial_json[index].push_str(s);
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                let index = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if index < self.blocks.len() && !self.partial_json[index].is_empty() {
                    let parsed = serde_json::from_str::<Value>(&self.partial_json[index]).unwrap_or(Value::Object(Map::new()));
                    if let Some(b) = self.blocks[index].as_object_mut() {
                        b.insert("input".into(), parsed);
                    }
                }
            }
            Some("message_delta") => {
                if let (Some(m), Some(d)) = (self.message.as_mut().and_then(Value::as_object_mut), v.get("delta").and_then(Value::as_object)) {
                    for (k, val) in d {
                        m.insert(k.clone(), val.clone());
                    }
                }
                if let (Some(m), Some(u)) = (self.message.as_mut().and_then(Value::as_object_mut), v.get("usage").and_then(Value::as_object)) {
                    let usage = m.entry("usage").or_insert_with(|| json!({}));
                    if let Some(uo) = usage.as_object_mut() {
                        for (k, val) in u {
                            uo.insert(k.clone(), val.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn chat(&mut self, v: Value) {
        if self.chat_head.is_none() {
            let mut head = v.clone();
            if let Some(o) = head.as_object_mut() {
                o.remove("choices");
                o.insert("object".into(), Value::String("chat.completion".into()));
            }
            self.chat_head = Some(head);
        }
        if let Some(usage) = v.get("usage") {
            if !usage.is_null() {
                if let Some(h) = self.chat_head.as_mut().and_then(Value::as_object_mut) {
                    h.insert("usage".into(), usage.clone());
                }
            }
        }
        let Some(choices) = v.get("choices").and_then(Value::as_array) else { return };
        for (ci, choice) in choices.iter().enumerate() {
            let index = choice.get("index").and_then(Value::as_u64).unwrap_or(ci as u64);
            let entry = self.chat_choices.entry(index.to_string()).or_insert_with(|| {
                json!({ "index": index, "message": { "role": "assistant", "content": Value::Null }, "finish_reason": Value::Null })
            });
            if let Some(fr) = choice.get("finish_reason") {
                if !fr.is_null() {
                    entry["finish_reason"] = fr.clone();
                }
            }
            let Some(delta) = choice.get("delta").and_then(Value::as_object) else { continue };
            let msg = entry.get_mut("message").unwrap();
            if let Some(r) = delta.get("role").and_then(Value::as_str) {
                msg["role"] = Value::String(r.to_string());
            }
            for field in ["content", "reasoning_content", "reasoning", "refusal"] {
                if let Some(s) = delta.get(field).and_then(Value::as_str) {
                    append(msg, field, Some(&Value::String(s.to_string())));
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                let list = msg.as_object_mut().unwrap().entry("tool_calls").or_insert_with(|| json!([]));
                let list = list.as_array_mut().unwrap();
                for (n, call) in calls.iter().enumerate() {
                    let i = call.get("index").and_then(Value::as_u64).unwrap_or(n as u64) as usize;
                    while list.len() <= i {
                        list.push(json!({ "index": list.len(), "type": "function", "function": { "name": "", "arguments": "" } }));
                    }
                    let target = &mut list[i];
                    if let Some(id) = call.get("id") {
                        target["id"] = id.clone();
                    }
                    if let Some(f) = call.get("function").and_then(Value::as_object) {
                        if let Some(name) = f.get("name").and_then(Value::as_str) {
                            append(&mut target["function"], "name", Some(&Value::String(name.to_string())));
                        }
                        if let Some(a) = f.get("arguments").and_then(Value::as_str) {
                            append(&mut target["function"], "arguments", Some(&Value::String(a.to_string())));
                        }
                    }
                }
            }
        }
    }

    fn responses(&mut self, v: Value) {
        // The terminal events carry the whole response object.
        match v.get("type").and_then(Value::as_str) {
            Some("response.completed") | Some("response.incomplete") | Some("response.failed") => {
                self.responses_final = v.get("response").cloned();
            }
            Some("response.created") if self.responses_final.is_none() => {
                self.responses_final = v.get("response").cloned();
            }
            _ => {}
        }
    }

    fn gemini(&mut self, v: Value) {
        if self.gemini_head.is_none() {
            let mut head = v.clone();
            if let Some(o) = head.as_object_mut() {
                o.remove("candidates");
            }
            self.gemini_head = Some(head);
        } else if let Some(um) = v.get("usageMetadata") {
            if let Some(h) = self.gemini_head.as_mut().and_then(Value::as_object_mut) {
                h.insert("usageMetadata".into(), um.clone());
            }
        }
        let Some(cands) = v.get("candidates").and_then(Value::as_array) else { return };
        for (ci, cand) in cands.iter().enumerate() {
            let index = cand.get("index").and_then(Value::as_u64).unwrap_or(ci as u64);
            let entry = self.gemini_candidates.entry(index.to_string()).or_insert_with(|| json!({ "index": index, "content": { "role": "model", "parts": [] } }));
            if let Some(fr) = cand.get("finishReason") {
                entry["finishReason"] = fr.clone();
            }
            let Some(parts) = cand.get("content").and_then(|c| c.get("parts")).and_then(Value::as_array) else { continue };
            let out = entry["content"]["parts"].as_array_mut().unwrap();
            for part in parts {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    // consecutive text parts concatenate
                    if let Some(last) = out.last_mut() {
                        if let Some(lt) = last.get("text").and_then(Value::as_str).map(str::to_string) {
                            last["text"] = Value::String(lt + t);
                            continue;
                        }
                    }
                    out.push(json!({ "text": t }));
                } else {
                    out.push(part.clone());
                }
            }
        }
    }

    /// The complete response body, or None when nothing usable arrived.
    pub fn finish(mut self) -> Option<Value> {
        if !self.carry.is_empty() {
            let rest = std::mem::take(&mut self.carry);
            self.frame(&rest);
        }
        match self.protocol {
            Some(Protocol::AnthropicMessages) => {
                let mut m = self.message?;
                for (i, b) in self.blocks.iter_mut().enumerate() {
                    if !self.partial_json[i].is_empty() && b.get("input").map(|x| x.as_object().map(|o| o.is_empty()).unwrap_or(true)).unwrap_or(true) {
                        if let Ok(parsed) = serde_json::from_str::<Value>(&self.partial_json[i]) {
                            if let Some(bo) = b.as_object_mut() {
                                bo.insert("input".into(), parsed);
                            }
                        }
                    }
                }
                m["content"] = Value::Array(self.blocks.into_iter().filter(|b| !b.is_null()).collect());
                Some(m)
            }
            Some(Protocol::OpenAiChat) => {
                let mut head = self.chat_head?;
                let mut choices: Vec<(u64, Value)> = self.chat_choices.into_iter().map(|(k, v)| (k.parse().unwrap_or(0), v)).collect();
                choices.sort_by_key(|(k, _)| *k);
                head["choices"] = Value::Array(choices.into_iter().map(|(_, v)| v).collect());
                Some(head)
            }
            Some(Protocol::OpenAiResponses) => self.responses_final,
            Some(Protocol::Gemini) => {
                let mut head = self.gemini_head?;
                let mut cands: Vec<(u64, Value)> = self.gemini_candidates.into_iter().map(|(k, v)| (k.parse().unwrap_or(0), v)).collect();
                cands.sort_by_key(|(k, _)| *k);
                head["candidates"] = Value::Array(cands.into_iter().map(|(_, v)| v).collect());
                Some(head)
            }
            _ => None,
        }
    }
}

fn append(target: &mut Value, field: &str, piece: Option<&Value>) {
    let Some(piece) = piece.and_then(Value::as_str) else { return };
    let Some(o) = target.as_object_mut() else { return };
    match o.get_mut(field) {
        Some(Value::String(s)) => s.push_str(piece),
        _ => {
            o.insert(field.to_string(), Value::String(piece.to_string()));
        }
    }
}

fn find_frame_end(s: &str) -> Option<(usize, usize)> {
    let b = s.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'\n' && b[i + 1] == b'\n' {
            return Some((i, i + 2));
        }
        if i + 3 < b.len() && b[i] == b'\r' && b[i + 1] == b'\n' && b[i + 2] == b'\r' && b[i + 3] == b'\n' {
            return Some((i, i + 4));
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_stream_becomes_a_message() {
        let mut r = Reassembler::new(Protocol::AnthropicMessages);
        r.feed("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude\",\"content\":[],\"usage\":{\"input_tokens\":10}}}\n\n");
        r.feed("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n");
        r.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n");
        r.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n");
        r.feed("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
        r.feed("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{}}}\n\n");
        r.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\": \\\"ec\"}}\n\n");
        r.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"ho OGRK00000001\\\"}\"}}\n\n");
        r.feed("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        let m = r.finish().unwrap();
        assert_eq!(m["content"][0]["text"], "Hello");
        assert_eq!(m["content"][1]["input"]["command"], "echo OGRK00000001");
        assert_eq!(m["stop_reason"], "tool_use");
        assert_eq!(m["usage"]["output_tokens"], 7);
        assert_eq!(m["usage"]["input_tokens"], 10);
    }

    #[test]
    fn chat_stream_merges_deltas_and_tool_calls() {
        let mut r = Reassembler::new(Protocol::OpenAiChat);
        r.feed("data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Hi \"}}]}\n\n");
        r.feed("data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"there\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"c\"}}]}}]}\n\n");
        r.feed("data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"md\\\":1}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":5}}\n\ndata: [DONE]\n\n");
        let m = r.finish().unwrap();
        assert_eq!(m["object"], "chat.completion");
        assert_eq!(m["choices"][0]["message"]["content"], "Hi there");
        assert_eq!(m["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"], "{\"cmd\":1}");
        assert_eq!(m["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(m["usage"]["prompt_tokens"], 5);
    }

    #[test]
    fn responses_uses_the_terminal_event() {
        let mut r = Reassembler::new(Protocol::OpenAiResponses);
        r.feed("event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"output\":[]}}\n\n");
        r.feed("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"output\":[{\"type\":\"function_call\",\"arguments\":\"{}\"}]}}\n\n");
        let m = r.finish().unwrap();
        assert_eq!(m["output"][0]["type"], "function_call");
    }
}
