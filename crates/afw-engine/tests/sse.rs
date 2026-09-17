use afw_engine::{Protocol, RestoreKeys, Stream};

fn keys() -> RestoreKeys {
    RestoreKeys::from_pairs([("${OGR_SECRET_1}", "AKIAIOSFODNN7EXAMPLE"), ("${OGR_SECRET_2}", "p\"w\\d")]).freeze()
}

#[test]
fn anthropic_text_delta_split_token_restores_and_flushes_before_stop() {
    let k = keys();
    let mut s = Stream::new(Protocol::AnthropicMessages, &k);
    let mut out = String::new();
    out.push_str(&s.feed("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\"}}\n\n"));
    out.push_str(&s.feed("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"));
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"key ${OGR_SE\"}}\n\n"));
    assert!(out.contains("\"text\":\"key \""), "held the tail: {out}");
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"CRET_1} done; cost $\"}}\n\n"));
    assert!(out.contains("AKIAIOSFODNN7EXAMPLE done; cost "), "{out}");
    out.push_str(&s.feed("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"));
    // the held "$" was flushed as its own delta BEFORE the stop
    let flush_at = out.find("\"text\":\"$\"").expect("flushed tail");
    let stop_at = out.find("content_block_stop").unwrap();
    assert!(flush_at < stop_at, "{out}");
    out.push_str(&s.end());
    assert_eq!(s.report().unresolved, Vec::<String>::new());
}

#[test]
fn anthropic_tool_input_json_delta_is_json_escaped() {
    let k = keys();
    let mut s = Stream::new(Protocol::AnthropicMessages, &k);
    let mut out = String::new();
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\": \\\"echo ${OGR_SECRET_2}\"}}\n\n"));
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"}\"}}\n\n"));
    out.push_str(&s.feed("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n"));
    out.push_str(&s.end());
    // Reassemble partial_json from the emitted frames and parse it.
    let mut json = String::new();
    for line in out.lines().filter(|l| l.starts_with("data:")) {
        let v: serde_json::Value = serde_json::from_str(&line[5..].trim()).unwrap();
        if let Some(p) = v["delta"]["partial_json"].as_str() {
            json.push_str(p);
        }
    }
    let parsed: serde_json::Value = serde_json::from_str(&json).expect(&json);
    assert_eq!(parsed["command"], "echo p\"w\\d");
}

#[test]
fn anthropic_unknown_token_in_tool_input_is_reported() {
    let k = keys();
    let mut s = Stream::new(Protocol::AnthropicMessages, &k);
    let mut out = String::new();
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"c\\\": \\\"${OGR_SECRET_9}\\\"}\"}}\n\n"));
    out.push_str(&s.feed("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n"));
    out.push_str(&s.end());
    assert_eq!(s.report().unresolved, vec!["${OGR_SECRET_9}".to_string()]);
    assert!(out.contains("${OGR_SECRET_9}"));
}

#[test]
fn chat_completions_arguments_and_content_restore() {
    let k = keys();
    let mut s = Stream::new(Protocol::OpenAiChat, &k);
    let mut out = String::new();
    out.push_str(&s.feed("data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"use ${OGR_SECRET_\"}}]}\n\n"));
    out.push_str(&s.feed("data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"1} now\",\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"k\\\":\\\"${OGR_SECRET_1}\\\"}\"}}]}}]}\n\n"));
    out.push_str(&s.feed("data: {\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"));
    out.push_str(&s.end());
    assert!(out.contains("use AKIAIOSFODNN7EXAMPLE now") || out.contains("\"content\":\"use \"") && out.contains("AKIAIOSFODNN7EXAMPLE now"), "{out}");
    assert!(out.contains("{\\\"k\\\":\\\"AKIAIOSFODNN7EXAMPLE\\\"}"), "{out}");
    assert!(out.ends_with("data: [DONE]\n\n"));
}

#[test]
fn responses_function_call_arguments_delta_and_done() {
    let k = keys();
    let mut s = Stream::new(Protocol::OpenAiResponses, &k);
    let mut out = String::new();
    out.push_str(&s.feed("event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{\\\"cmd\\\":\\\"${OGR_SEC\"}\n\n"));
    out.push_str(&s.feed("event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"RET_1}\\\"}\"}\n\n"));
    out.push_str(&s.feed("event: response.function_call_arguments.done\ndata: {\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"arguments\":\"{\\\"cmd\\\":\\\"${OGR_SECRET_1}\\\"}\"}\n\n"));
    out.push_str(&s.end());
    assert_eq!(out.matches("AKIAIOSFODNN7EXAMPLE").count(), 2, "{out}");
    assert!(!out.contains("${OGR_SECRET_1}"), "{out}");
}

#[test]
fn unknown_protocol_passes_bytes_through() {
    let k = keys();
    let mut s = Stream::new(Protocol::Unknown, &k);
    let text = "data: {\"x\":\"${OGR_SECRET_1}\"}\n\n";
    assert_eq!(s.feed(text), text);
    assert_eq!(s.end(), "");
}

#[test]
fn gemini_text_parts_and_function_call_args_restore() {
    let k = keys();
    let mut s = Stream::new(Protocol::Gemini, &k);
    let mut out = String::new();
    out.push_str(&s.feed("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"key ${OGR_SE\"}],\"role\":\"model\"},\"index\":0}]}\r\n\r\n"));
    assert!(out.contains("\"text\":\"key \""), "{out}");
    out.push_str(&s.feed("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"CRET_1} ok\"},{\"functionCall\":{\"name\":\"run\",\"args\":{\"cmd\":\"echo ${OGR_SECRET_2}\"}}}],\"role\":\"model\"},\"finishReason\":\"STOP\",\"index\":0}]}\r\n\r\n"));
    out.push_str(&s.end());
    assert!(out.contains("AKIAIOSFODNN7EXAMPLE ok"), "{out}");
    assert!(out.contains("echo p\\\"w\\\\d"), "{out}");
    assert!(s.report().unresolved.is_empty());
    assert_eq!(Protocol::from_path("/v1beta/models/gemini-2.5-pro:streamGenerateContent"), Protocol::Gemini);
}

#[test]
fn anthropic_ogrk_token_split_in_text_delta() {
    let k = RestoreKeys::from_pairs([("OGRKF0000007", "AKIAIOSFODNN7EXAMPLE")]).freeze();
    let mut s = Stream::new(Protocol::AnthropicMessages, &k);
    let mut out = String::new();
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"use OGRKF00\"}}\n\n"));
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"00007\"}}\n\n"));
    assert!(out.contains("AKIAIOSFODNN7EXAMPLE"), "a complete fixed-width token restores at once: {out}");
    out.push_str(&s.feed("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" now\"}}\n\n"));
    assert!(out.contains("AKIAIOSFODNN7EXAMPLE") && out.contains(" now"), "{out}");
    out.push_str(&s.end());
    assert!(s.report().unresolved.is_empty());
}
