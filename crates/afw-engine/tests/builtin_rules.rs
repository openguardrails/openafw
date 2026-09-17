//! The shipped ruleset must compile with EVERY rule enabled in this engine:
//! a rule that fails its own examples here is a dialect drift between
//! fancy-regex and V8/CPython, and the fix is in the pattern upstream.

use afw_engine::{builtin_ruleset, compile, mask, mask_value, SessionMap, DEFAULT_TIERS};

#[test]
fn every_builtin_rule_passes_its_examples_here() {
    let rs = builtin_ruleset();
    let compiled = compile(&rs, DEFAULT_TIERS);
    assert!(compiled.disabled.is_empty(), "disabled: {:#?}", compiled.disabled);
    assert_eq!(compiled.rules.len(), rs.rules.len());
    assert_eq!(compiled.id, rs.id);
}

#[test]
fn masks_a_claude_code_shaped_request() {
    let rs = builtin_ruleset();
    let compiled = compile(&rs, DEFAULT_TIERS);
    let mut map = SessionMap::new();
    let mut body = serde_json::json!({
        "model": "claude-sonnet-5",
        "system": "You are helpful. The deploy key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789.",
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": "run: curl -H 'Authorization: Bearer pk_cc7f7b3f73664638b8f30fe8ca598848' https://x"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AKIAIOSFODNN7EXAMPLEAAAA"}}
            ]},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "echo AKIAIOSFODNN7EXAMPLE"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "AKIAIOSFODNN7EXAMPLE\n"}]}
        ],
        "metadata": {"user_id": "{\"session_id\":\"abc\"}"}
    });
    let report = mask_value(&mut body, &mut map, Some(&compiled));
    assert!(report.changed);
    let text = body.to_string();
    assert!(!text.contains("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"));
    assert!(!text.contains("pk_cc7f7b3f73664638b8f30fe8ca598848"));
    assert!(!text.contains("echo AKIAIOSFODNN7EXAMPLE"));
    // image data untouched, ids untouched
    assert!(text.contains("AKIAIOSFODNN7EXAMPLEAAAA"));
    assert!(text.contains("toolu_1"));
    assert_eq!(map.len(), 3, "{text}");
    // the same value in tool_use.input and tool_result got ONE token
    let aws = map.entries().find(|(_, v)| *v == "AKIAIOSFODNN7EXAMPLE").map(|(t, _)| t.to_string()).unwrap();
    assert_eq!(text.matches(&aws).count(), 2);
}

#[test]
fn known_value_wins_without_a_rule() {
    afw_engine::set_minter_letter('F');
    let mut map = SessionMap::new();
    let t = map.token_for("hunter2-not-a-shape").token;
    let r = mask("pw is hunter2-not-a-shape ok", &mut map, None);
    assert_eq!(r.text, format!("pw is {t} ok"));
    assert_eq!(r.known, 1);
    assert_eq!(t, "OGRKF0000001");
}

#[test]
fn undelimited_tokens_restore_with_boundaries_and_stream_hold() {
    use afw_engine::restore::{feed, Tail};
    use afw_engine::{restore, Encode, RestoreKeys};
    let keys = RestoreKeys::from_pairs([("OGRKF0000001", "one"), ("OGRKF0000012", "twelve")]).freeze();
    let r = restore("a OGRKF0000001 b OGRKF0000012 c OGRKF00000012 d XOGRKF0000001 e OGRKF0000001.", &keys, Encode::Plain);
    assert_eq!(r.text, "a one b twelve c OGRKF00000012 d XOGRKF0000001 e one.");
    assert_eq!(r.unresolved, vec!["OGRKF00000012".to_string()], "a corrupted longer run is our shape and unanswerable");
    // streamed: a partial key is held; a complete fixed-width key restores at once
    let mut tail = Tail::default();
    assert_eq!(feed(&mut tail, "key OGRKF00000", &keys, Encode::Plain, false), "key ");
    assert_eq!(feed(&mut tail, "12 done", &keys, Encode::Plain, false), "twelve done");
    let mut tail = Tail::default();
    assert_eq!(feed(&mut tail, "key OGRKF0000001", &keys, Encode::Plain, false), "key one");
    assert_eq!(feed(&mut tail, "", &keys, Encode::Plain, true), "");
}

#[test]
fn cache_hit_is_exact_and_invalidates_when_the_map_grows() {
    use afw_engine::{mask_cached, MaskCache};
    let rs = builtin_ruleset();
    let compiled = compile(&rs, DEFAULT_TIERS);
    let mut map = SessionMap::new();
    let mut cache = MaskCache::new(1 << 20);
    let leaf = "the password for staging is Storewave@2022, keep it in the vault please, thanks a lot";
    let a = mask_cached(leaf, &mut map, Some(&compiled), &mut cache);
    let b = mask_cached(leaf, &mut map, Some(&compiled), &mut cache);
    assert_eq!(a.text, b.text);
    // a value no rule catches becomes known later → the cached leaf must be recomputed
    let plain = "note: the phrase keep it in the vault please is also our shared passphrase for now";
    let c1 = mask_cached(plain, &mut map, Some(&compiled), &mut cache);
    assert_eq!(c1.text, plain);
    map.token_for("keep it in the vault please");
    let c2 = mask_cached(plain, &mut map, Some(&compiled), &mut cache);
    assert!(c2.text.contains("OGRKF000"), "{}", c2.text);
    let d = mask_cached(leaf, &mut map, Some(&compiled), &mut cache);
    assert!(d.text.contains("OGRKF000"));
    assert!(cache.hits >= 1);
}

#[test]
fn ogrk_tokens_are_never_rematched_and_restore_exactly() {
    afw_engine::set_minter_letter('F'); // this crate's own letter
    use afw_engine::{restore, Encode, RestoreKeys, TokenFormat};
    let rs = builtin_ruleset();
    let compiled = compile(&rs, DEFAULT_TIERS);
    let mut map = SessionMap::with_format(TokenFormat::OgrKey);
    let text = "Authorization: Bearer OGRKF0000007 and sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    map.seed_above(afw_engine::mask::highest_secret_number(text)); // what the proxy does before masking
    let r = mask(text, &mut map, Some(&compiled));
    assert_eq!(r.text, "Authorization: Bearer OGRKF0000007 and OGRKF0000008", "existing token kept, counter seeded above it? {}", r.text);

    // Another minter's namespace is ordinary text: never re-masked, never
    // restored here, never a reason to refuse a tool call.
    let mut map2 = SessionMap::with_format(TokenFormat::OgrKey);
    let foreign = "runtime gave OGRKR0000003 and the plugin gave OGRKP0000001";
    let r2 = mask(foreign, &mut map2, Some(&compiled));
    assert_eq!(r2.text, foreign);
    assert_eq!(map2.len(), 0);
    let keys2 = RestoreKeys::from_pairs([("OGRKF0000001", "ours")]).freeze();
    let out2 = restore("use OGRKR0000003 then OGRKF0000001", &keys2, Encode::Plain);
    assert_eq!(out2.text, "use OGRKR0000003 then ours");
    assert!(out2.unresolved.is_empty(), "a foreign token is text, not an unresolved one: {:?}", out2.unresolved);
}
