//! The OGR local-redaction conformance corpus, run against this engine the
//! way the TypeScript and Python references run it.

use afw_engine::restore::{feed, Encode, Tail};
use afw_engine::{compile, mask, restore, RestoreKeys, Ruleset, SessionMap, TokenFormat, DEFAULT_TIERS};

/// The OGR 1.4 corpus as ratified (legacy `${OGR_SECRET_n}` minting) must keep passing too.
const CORPUS_V14: &str = include_str!("../../../rules/conformance/local-redaction.v1.4.json");
use serde_json::Value;

const CORPUS: &str = include_str!("../../../rules/conformance/local-redaction.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).unwrap()
}

/// Mint under the corpus's own minter letter, so its tokens compare byte for
/// byte. One process is one minter; a runner verifying a corpus another minter
/// produced has to mint under that corpus's letter or compare nothing.
fn adopt_corpus_minter(c: &Value) -> char {
    let letter = c
        .get("minter")
        .and_then(Value::as_str)
        .and_then(|m| m.chars().next())
        .expect("the corpus declares the minter it was produced under");
    afw_engine::set_minter_letter(letter);
    letter
}

fn ruleset(c: &Value) -> Ruleset {
    serde_json::from_value(c["ruleset"].clone()).unwrap()
}

/// Bind each fixture token to its value — either shape — the way an
/// integration adopts a token minted elsewhere.
fn seeded(fixture: &Value) -> SessionMap {
    let mut map = SessionMap::new();
    for (token, value) in fixture.as_object().unwrap() {
        map.insert_pair(token, value.as_str().unwrap());
    }
    map
}

#[test]
fn corpus_ruleset_compiles_with_every_rule_enabled() {
    adopt_corpus_minter(&corpus());
    let c = corpus();
    let compiled = compile(&ruleset(&c), DEFAULT_TIERS);
    assert!(compiled.disabled.is_empty(), "{:?}", compiled.disabled);
    assert_eq!(compiled.rules.len(), c["ruleset"]["rules"].as_array().unwrap().len());
}

#[test]
fn mask_cases() {
    let c = corpus();
    adopt_corpus_minter(&c);
    let compiled = compile(&ruleset(&c), DEFAULT_TIERS);
    for case in c["cases"]["mask"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut map = SessionMap::new();
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let r = mask(step.as_str().unwrap(), &mut map, Some(&compiled));
            let expect = &case["expect"][i];
            assert_eq!(r.text, expect["text"].as_str().unwrap(), "mask: {name} (step {i})");
            let minted: Vec<Value> =
                r.minted.iter().map(|m| serde_json::json!({ "token": m.token, "rule": m.rule })).collect();
            assert_eq!(Value::Array(minted), expect["minted"], "mask minted: {name} (step {i})");
        }
        if let Some(values) = case.get("values").and_then(Value::as_object) {
            let mut got: Vec<(String, String)> = map.entries().map(|(t, v)| (t.to_string(), v.to_string())).collect();
            got.sort();
            let mut want: Vec<(String, String)> =
                values.iter().map(|(t, v)| (t.to_string(), v.as_str().unwrap().to_string())).collect();
            want.sort();
            assert_eq!(got, want, "mask values: {name}");
        }
    }
}

#[test]
fn restore_cases() {
    let c = corpus();
    adopt_corpus_minter(&c);
    for case in c["cases"]["restore"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let keys = seeded(&case["map"]).all_keys().freeze();
        let r = restore(case["input"].as_str().unwrap(), &keys, Encode::Plain);
        let expect = &case["expect"];
        assert_eq!(r.text, expect["text"].as_str().unwrap(), "restore: {name}");
        let unresolved: Vec<Value> = r.unresolved.iter().map(|t| Value::String(t.clone())).collect();
        assert_eq!(Value::Array(unresolved), expect["unresolved"], "restore unresolved: {name}");
    }
}

#[test]
fn stream_cases() {
    let c = corpus();
    adopt_corpus_minter(&c);
    for case in c["cases"]["stream"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let keys = seeded(&case["map"]).all_keys().freeze();
        let expect = &case["expect"];
        // Deltas go in exactly as the corpus splits them: a token split
        // across a boundary is the whole point of these cases.
        let mut tail = Tail::default();
        for (i, delta) in case["deltas"].as_array().unwrap().iter().enumerate() {
            let out = feed(&mut tail, delta.as_str().unwrap(), &keys, Encode::Plain, false);
            assert_eq!(out, expect[i].as_str().unwrap(), "stream: {name} (delta {i})");
        }
        let end = feed(&mut tail, "", &keys, Encode::Plain, true);
        assert_eq!(end, case["end"].as_str().unwrap(), "stream end: {name}");
        assert_eq!(tail.pending, "", "stream pending: {name}");
    }
}

#[test]
fn legacy_corpus_still_passes_with_the_dollar_brace_format() {
    let c: Value = serde_json::from_str(CORPUS_V14).unwrap();
    let compiled = compile(&ruleset(&c), DEFAULT_TIERS);
    for case in c["cases"]["mask"].as_array().unwrap() {
        let mut map = SessionMap::with_format(TokenFormat::OgrDollarBrace);
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let r = mask(step.as_str().unwrap(), &mut map, Some(&compiled));
            assert_eq!(r.text, case["expect"][i]["text"].as_str().unwrap(), "legacy mask: {}", case["name"]);
        }
    }
    for case in c["cases"]["restore"].as_array().unwrap() {
        let keys = seeded(&case["map"]).all_keys().freeze();
        let r = restore(case["input"].as_str().unwrap(), &keys, Encode::Plain);
        assert_eq!(r.text, case["expect"]["text"].as_str().unwrap(), "legacy restore: {}", case["name"]);
    }
}

#[test]
fn restore_keys_from_pairs() {
    let keys = RestoreKeys::from_pairs([("${OGR_SECRET_1}", "one"), ("${OGR_SECRET_10}", "ten")]).freeze();
    let r = restore("${OGR_SECRET_10}/${OGR_SECRET_1}", &keys, Encode::Plain);
    assert_eq!(r.text, "ten/one");
}
