//! Mask — on the way OUT (OGR local-redaction §Mask), in this order:
//!
//!  1. Normalise for MATCHING only: zero-width and control characters are
//!     stripped from a working copy with an index back to the original.
//!  2. KNOWN values first, longest first.
//!  3. Then the ruleset in SERVED order; overlaps longest-wins, ties to order;
//!     never inside an existing `${OGR_…}` token.
//!  4. Splice on the original, in place, never remove.
//!
//! Ported from the OGR reference `@openguardrails/local-redaction` (`mask.ts`).

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::ruleset::{rule_spans, CompiledRuleset, Span};
use crate::session::SessionMap;

/// Any placeholder of the OGR shape, whichever allocator minted it.
pub static TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"OGRK[A-Z][0-9X]{7,}|OGRK[0-9X]{8,}|\$\{OGR_[A-Z_]+_[0-9A-Z]+\}").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Minted {
    pub token: String,
    /// `<rule id>/<pattern id>`.
    pub rule: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskResult {
    pub text: String,
    pub minted: Vec<Minted>,
    /// Occurrences of already-known values replaced (not minted).
    pub known: usize,
}

fn is_stripped(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{8}'
            | '\u{b}'
            | '\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{7f}'
            | '\u{200b}'..='\u{200f}'
            | '\u{2028}'..='\u{202e}'
            | '\u{2060}'
            | '\u{feff}'
    )
}

/// `index[i]` = original byte offset of stripped byte `i`; None when nothing was stripped.
fn normalize(text: &str) -> (Cow<'_, str>, Option<Vec<usize>>) {
    if !text.chars().any(is_stripped) {
        return (Cow::Borrowed(text), None);
    }
    let mut stripped = String::with_capacity(text.len());
    let mut index = Vec::with_capacity(text.len());
    for (i, ch) in text.char_indices() {
        if is_stripped(ch) {
            continue;
        }
        for k in 0..ch.len_utf8() {
            index.push(i + k);
        }
        stripped.push(ch);
    }
    (Cow::Owned(stripped), Some(index))
}

fn overlaps_any(span: Span, spans: &[Span]) -> bool {
    spans.iter().any(|s| span.start < s.end && s.start < span.end)
}

struct Replacement {
    span: Span,
    token: String,
}

fn overlaps_repl(span: Span, repls: &[Replacement]) -> bool {
    repls.iter().any(|r| span.start < r.span.end && r.span.start < span.end)
}

pub fn mask(text: &str, map: &mut SessionMap, compiled: Option<&CompiledRuleset>) -> MaskResult {
    if text.is_empty() {
        return MaskResult { text: String::new(), minted: Vec::new(), known: 0 };
    }
    let (stripped, index) = normalize(text);
    let stripped: &str = &stripped;
    let tokens: Vec<Span> = TOKEN_RE.find_iter(stripped).map(|m| Span { start: m.start(), end: m.end() }).collect();
    let mut accepted: Vec<Replacement> = Vec::new();
    let mut known = 0usize;

    // 2. Known values, longest first.
    let values: Vec<String> = map.values_longest_first().to_vec();
    for value in &values {
        if value.is_empty() {
            continue;
        }
        let token = map.token_for(value).token;
        let mut from = 0usize;
        while let Some(at) = stripped[from..].find(value.as_str()) {
            let start = from + at;
            let span = Span { start, end: start + value.len() };
            if !overlaps_any(span, &tokens) && !overlaps_repl(span, &accepted) {
                accepted.push(Replacement { span, token: token.clone() });
                known += 1;
            }
            from = span.end;
        }
    }

    // 3. The ruleset, served order; longest wins, ties to array order.
    let mut minted = Vec::new();
    if let Some(compiled) = compiled {
        if !compiled.rules.is_empty() {
            struct Cand {
                span: Span,
                rule: String,
                order: usize,
            }
            let mut candidates: Vec<Cand> = Vec::new();
            for rule in &compiled.rules {
                for s in rule_spans(rule, stripped) {
                    let span = Span { start: s.start, end: s.end };
                    if overlaps_any(span, &tokens) {
                        continue;
                    }
                    let order = candidates.len();
                    candidates.push(Cand { span, rule: format!("{}/{}", rule.id, s.pattern), order });
                }
            }
            candidates.sort_by(|a, b| {
                let la = a.span.end - a.span.start;
                let lb = b.span.end - b.span.start;
                lb.cmp(&la).then_with(|| a.order.cmp(&b.order))
            });
            let mut chosen: Vec<Cand> = Vec::new();
            for c in candidates {
                if overlaps_repl(c.span, &accepted) || chosen.iter().any(|k| c.span.start < k.span.end && k.span.start < c.span.end) {
                    continue;
                }
                chosen.push(c);
            }
            // Mint left to right so token numbers read in text order.
            chosen.sort_by_key(|c| c.span.start);
            let mut seen: Vec<String> = Vec::new();
            for c in chosen {
                let value = &stripped[c.span.start..c.span.end];
                let grant = map.token_for(value);
                accepted.push(Replacement { span: c.span, token: grant.token.clone() });
                if grant.fresh && !seen.contains(&grant.token) {
                    seen.push(grant.token.clone());
                    minted.push(Minted { token: grant.token, rule: c.rule });
                }
            }
        }
    }

    if accepted.is_empty() {
        return MaskResult { text: text.to_string(), minted, known };
    }

    // 4. Splice on the ORIGINAL, mapping stripped offsets back.
    accepted.sort_by_key(|r| r.span.start);
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for r in &accepted {
        let (os, oe) = match &index {
            Some(ix) => (ix[r.span.start], ix[r.span.end - 1] + 1),
            None => (r.span.start, r.span.end),
        };
        out.push_str(&text[cursor..os]);
        out.push_str(&r.token);
        cursor = oe;
    }
    out.push_str(&text[cursor..]);
    MaskResult { text: out, minted, known }
}

/// Keys that name STRUCTURE rather than carry content — left alone by the
/// leaf walk so a masked request keeps every id the host and provider
/// correlate on.
pub const STRUCTURAL_KEYS: &[&str] = &[
    "role",
    "type",
    "id",
    "model",
    "name",
    "object",
    "status",
    "finish_reason",
    "stop_reason",
    "stopReason",
    "tool_call_id",
    "tool_use_id",
    "call_id",
    "callID",
    "sessionID",
    "messageID",
    "toolCallId",
    "toolName",
    "tool",
    "provider",
    "api",
    "mimeType",
    "media_type",
    "textSignature",
    "thinkingSignature",
    "signature",
    "cache_control",
];

fn is_image_block(obj: &serde_json::Map<String, Value>) -> bool {
    match obj.get("type").and_then(Value::as_str) {
        Some("image") | Some("image_url") | Some("input_image") | Some("document") => true,
        _ => obj.get("mimeType").map(Value::is_string).unwrap_or(false),
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WalkReport {
    pub minted: Vec<Minted>,
    pub known: usize,
    pub changed: bool,
}

/// Mask every string leaf of a JSON value in place. Structure, ids and
/// base64 media are untouched.
pub fn mask_value(value: &mut Value, map: &mut SessionMap, compiled: Option<&CompiledRuleset>) -> WalkReport {
    let mut report = WalkReport::default();
    walk(value, None, false, map, compiled, &mut report);
    report
}

fn walk(
    v: &mut Value,
    key: Option<&str>,
    parent_is_media: bool,
    map: &mut SessionMap,
    compiled: Option<&CompiledRuleset>,
    report: &mut WalkReport,
) {
    match v {
        Value::String(s) => {
            if let Some(k) = key {
                if STRUCTURAL_KEYS.contains(&k) {
                    return;
                }
                if k == "data" && parent_is_media {
                    return;
                }
            }
            let r = mask(s, map, compiled);
            report.known += r.known;
            report.minted.extend(r.minted);
            if r.text != *s {
                *s = r.text;
                report.changed = true;
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, None, false, map, compiled, report);
            }
        }
        Value::Object(obj) => {
            let media = is_image_block(obj);
            for (k, val) in obj.iter_mut() {
                let k: &str = k;
                walk(val, Some(k), media, map, compiled, report);
            }
        }
        _ => {}
    }
}

/// Every `${OGR_…}` token present in a text, deduplicated, in order.
pub fn tokens_present(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in TOKEN_RE.find_iter(text) {
        if !out.iter().any(|t| t == m.as_str()) {
            out.push(m.as_str().to_string());
        }
    }
    out
}

/// The highest number in OUR OWN namespace that a body carries.
///
/// Since the namespace split this is only a belt-and-braces floor for a body
/// that carries tokens this host minted but whose map was forgotten; another
/// minter's numbers are none of our business and are deliberately ignored.
pub fn highest_secret_number(text: &str) -> u64 {
    TOKEN_RE
        .find_iter(text)
        .filter(|m| crate::session::is_ours(m.as_str()))
        .filter_map(|m| crate::session::token_number(m.as_str()))
        .max()
        .unwrap_or(0)
}

/// A cache of masked leaves. Every turn an agent resends its whole history,
/// so most leaves of a request were masked before. An entry is valid only
/// while the session map has not grown since it was computed: a value minted
/// later could occur unmasked in an older leaf, and step 2 ("known values
/// first") must see it. Mints are rare, so the hit rate stays high.
#[derive(Debug, Default)]
pub struct MaskCache {
    entries: std::collections::HashMap<String, CachedLeaf>,
    bytes: usize,
    pub max_bytes: usize,
    pub min_leaf: usize,
    pub hits: u64,
    pub misses: u64,
}

#[derive(Debug, Clone)]
struct CachedLeaf {
    masked: String,
    known: usize,
    map_len: usize,
}

impl MaskCache {
    pub fn new(max_bytes: usize) -> Self {
        Self { max_bytes, min_leaf: 48, ..Default::default() }
    }

    fn get(&mut self, text: &str, map_len: usize) -> Option<(String, usize)> {
        match self.entries.get(text) {
            Some(e) if e.map_len == map_len => {
                self.hits += 1;
                Some((e.masked.clone(), e.known))
            }
            _ => {
                self.misses += 1;
                None
            }
        }
    }

    fn put(&mut self, text: &str, masked: &str, known: usize, map_len: usize) {
        let cost = text.len() + masked.len();
        if self.bytes + cost > self.max_bytes {
            self.entries.clear();
            self.bytes = 0;
        }
        if let Some(old) = self.entries.insert(text.to_string(), CachedLeaf { masked: masked.to_string(), known, map_len }) {
            self.bytes = self.bytes.saturating_sub(text.len() + old.masked.len());
        }
        self.bytes += cost;
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// [`mask`] through a [`MaskCache`]. A cache hit never mints (a hit means no
/// new value was in the leaf when it was computed, and the map has not grown).
pub fn mask_cached(text: &str, map: &mut SessionMap, compiled: Option<&CompiledRuleset>, cache: &mut MaskCache) -> MaskResult {
    if text.len() < cache.min_leaf {
        return mask(text, map, compiled);
    }
    let map_len = map.len();
    if let Some((masked, known)) = cache.get(text, map_len) {
        return MaskResult { text: masked, minted: Vec::new(), known };
    }
    let r = mask(text, map, compiled);
    if r.minted.is_empty() {
        cache.put(text, &r.text, r.known, map.len());
    }
    r
}

/// [`mask_value`] with a leaf cache.
pub fn mask_value_cached(
    value: &mut Value,
    map: &mut SessionMap,
    compiled: Option<&CompiledRuleset>,
    cache: &mut MaskCache,
) -> WalkReport {
    let mut report = WalkReport::default();
    walk_cached(value, None, false, map, compiled, cache, &mut report);
    report
}

fn walk_cached(
    v: &mut Value,
    key: Option<&str>,
    parent_is_media: bool,
    map: &mut SessionMap,
    compiled: Option<&CompiledRuleset>,
    cache: &mut MaskCache,
    report: &mut WalkReport,
) {
    match v {
        Value::String(s) => {
            if let Some(k) = key {
                if STRUCTURAL_KEYS.contains(&k) {
                    return;
                }
                if k == "data" && parent_is_media {
                    return;
                }
            }
            let r = mask_cached(s, map, compiled, cache);
            report.known += r.known;
            report.minted.extend(r.minted);
            if r.text != *s {
                *s = r.text;
                report.changed = true;
            }
        }
        Value::Array(items) => {
            for item in items {
                walk_cached(item, None, false, map, compiled, cache, report);
            }
        }
        Value::Object(obj) => {
            let media = is_image_block(obj);
            for (k, val) in obj.iter_mut() {
                let k: &str = k;
                walk_cached(val, Some(k), media, map, compiled, cache, report);
            }
        }
        _ => {}
    }
}
