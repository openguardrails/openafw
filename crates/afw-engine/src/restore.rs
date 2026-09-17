//! Restore — on the way back to the host.
//!
//! Whole-token exact match only, longest key first, with one latitude: a `\`
//! before markdown-escapable punctuation inside a token is absorbed, so
//! `${OGR\_SECRET\_1}` restores. NEVER fuzzy, never prefix — a restorer that
//! guesses is an exfiltration oracle.
//!
//! The streaming form feeds text per delta: a complete key is replaced
//! wherever it lands; a PARTIAL key at the end of what has arrived is held
//! until the next delta completes it, or `is_last` says nothing more comes.
//! Every streamed field needs its OWN pending tail.
//!
//! Ported from the OGR reference `restore.ts` (itself the higress `Restorer`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::session::RestoreKeys;

/// The notice a blocked tool call carries, verbatim from the specification.
pub fn unrestorable_notice(token: &str) -> String {
    format!(
        "{token} could not be restored: it is not a placeholder this session issued. \
Placeholders must be used exactly as they appear in your context; if the value was \
shown in an earlier session, ask the user to provide it again."
    )
}

const ESCAPABLE: &[u8] = b"_*${}[]()#+-.!`~|<>\\";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Match {
    None,
    Full,
    /// The text ended before the key did.
    Truncated,
}

/// Match `key` at `text[i]`, absorbing rendered escapes. Returns the RAW span
/// covered (escapes make it longer than the key) and the status.
fn match_key(text: &[u8], i: usize, key: &[u8]) -> (usize, Match) {
    let mut p = i;
    for &kc in key {
        if p >= text.len() {
            return (0, Match::Truncated);
        }
        if text[p] == b'\\' && kc != b'\\' {
            if p + 1 >= text.len() {
                return (0, Match::Truncated);
            }
            if ESCAPABLE.contains(&text[p + 1]) {
                p += 1;
            }
        }
        if text[p] != kc {
            return (0, Match::None);
        }
        p += 1;
    }
    (p - i, Match::Full)
}

/// A tolerant scan for placeholder shapes, escaped or not, normalised to the bare token.
static TOKEN_SHAPE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"OGRK[A-Z][0-9X]{7,}|OGRK[0-9X]{8,}|\\?\$\\?\{OGR(?:\\?_[A-Z]+)*\\?_[0-9A-Z]+\\?\}").unwrap()
});

/// Placeholder-shaped tokens in `text`, escapes removed. Only OUR namespace:
/// another minter's token is ordinary text to us, and reporting it as
/// unresolved would refuse a tool call that the next restorer can complete.
pub fn tokens_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in TOKEN_SHAPE_RE.find_iter(text) {
        let t = m.as_str().replace('\\', "");
        if crate::session::is_ours(&t) && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// How a restored value is written into the surrounding text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encode {
    /// The value itself.
    Plain,
    /// As it must appear INSIDE a JSON string literal (an OpenAI
    /// `function.arguments` string, an Anthropic `partial_json` fragment).
    JsonString,
}

pub fn json_string_encode(value: &str) -> String {
    let s = serde_json::to_string(value).expect("string serialises");
    s[1..s.len() - 1].to_string()
}

fn encode(value: &str, how: Encode) -> String {
    match how {
        Encode::Plain => value.to_string(),
        Encode::JsonString => json_string_encode(value),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreResult {
    pub text: String,
    /// Placeholder-shaped tokens (escapes removed) that no key answers.
    pub unresolved: Vec<String>,
    pub restored: usize,
}

pub struct Extracted {
    pub output: String,
    pub pending: String,
    pub restored: usize,
}

/// `Extract`: replace every complete key in `text`; split the remainder into
/// output and a pending tail that may be the beginning of a key. With
/// `is_last`, nothing is held back.
pub fn extract(text: &str, keys: &RestoreKeys, how: Encode, is_last: bool) -> Extracted {
    let tokens = keys.tokens_sorted();
    if tokens.is_empty() || text.is_empty() {
        return Extracted { output: text.to_string(), pending: String::new(), restored: 0 };
    }
    let bytes = text.as_bytes();
    let mut starts = [false; 256];
    starts[b'\\' as usize] = true;
    let mut longest = 0usize;
    for k in tokens {
        starts[k.as_bytes()[0] as usize] = true;
        longest = longest.max(k.len());
    }
    let max_raw = longest * 2 + 2;
    let mut out = String::with_capacity(text.len());
    let mut flushed = 0usize;
    let mut i = 0usize;
    let mut restored = 0usize;
    while i < bytes.len() {
        if !starts[bytes[i] as usize] {
            i += 1;
            continue;
        }
        // An undelimited key must not be the tail of a word or the head of a
        // longer run of digits: a letter, digit or hyphen glued to either side
        // means this is not the token.
        let left_ok = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'-');
        let mut partial = false;
        let mut hit: Option<(&str, usize)> = None;
        for k in tokens {
            let (raw, status) = match_key(bytes, i, k.as_bytes());
            match status {
                Match::Full => {
                    // A fixed-width key (`OGRK00000001`) is complete the moment its
                    // last character is seen; only a letter or digit glued to
                    // either side says this is not the token.
                    let undelimited = !k.ends_with('}');
                    if undelimited {
                        if !left_ok {
                            continue;
                        }
                        let end = i + raw;
                        if end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
                            continue;
                        }
                    }
                    hit = Some((k, raw));
                    break;
                }
                Match::Truncated => partial = true, // a SHORTER key may still match in full
                Match::None => {}
            }
        }
        if let Some((k, raw)) = hit {
            out.push_str(&text[flushed..i]);
            out.push_str(&encode(keys.value_of(k).unwrap_or(""), how));
            restored += 1;
            i += raw;
            flushed = i;
            continue;
        }
        if partial && !is_last && bytes.len() - i <= max_raw {
            out.push_str(&text[flushed..i]);
            return Extracted { output: out, pending: text[i..].to_string(), restored };
        }
        i += 1;
    }
    out.push_str(&text[flushed..]);
    Extracted { output: out, pending: String::new(), restored }
}

/// A per-field streaming tail.
#[derive(Debug, Default, Clone)]
pub struct Tail {
    pub pending: String,
    /// The restored field text so far — scanned for tokens no key answers.
    pub seen: String,
}

/// `Feed`: append `text` to the tail, return what is safe to emit, keep the
/// unresolved remainder pending.
pub fn feed(tail: &mut Tail, text: &str, keys: &RestoreKeys, how: Encode, is_last: bool) -> String {
    let joined = if tail.pending.is_empty() { text.to_string() } else { format!("{}{}", tail.pending, text) };
    let r = extract(&joined, keys, how, is_last);
    tail.pending = r.pending;
    tail.seen.push_str(&r.output);
    r.output
}

pub fn restore(text: &str, keys: &RestoreKeys, how: Encode) -> RestoreResult {
    let r = extract(text, keys, how, true);
    let unresolved = tokens_in(&r.output).into_iter().filter(|t| keys.value_of(t).is_none()).collect();
    RestoreResult { text: r.output, unresolved, restored: r.restored }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    pub restored: usize,
    pub unresolved: Vec<String>,
    pub changed: bool,
}

impl RestoreReport {
    fn absorb(&mut self, r: &RestoreResult) {
        self.restored += r.restored;
        for t in &r.unresolved {
            if !self.unresolved.contains(t) {
                self.unresolved.push(t.clone());
            }
        }
    }
}

/// Restore every string leaf of a JSON value in place (design §6.1: on the
/// way back to the host, everything restores).
pub fn restore_value(value: &mut Value, keys: &RestoreKeys) -> RestoreReport {
    let mut report = RestoreReport::default();
    walk(value, keys, &mut report);
    report
}

fn walk(v: &mut Value, keys: &RestoreKeys, report: &mut RestoreReport) {
    match v {
        Value::String(s) => {
            if !s.contains('$') && !s.contains('\\') {
                return;
            }
            let r = restore(s, keys, Encode::Plain);
            report.absorb(&r);
            if r.text != *s {
                *s = r.text;
                report.changed = true;
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, keys, report);
            }
        }
        Value::Object(obj) => {
            for (_, val) in obj.iter_mut() {
                walk(val, keys, report);
            }
        }
        _ => {}
    }
}
