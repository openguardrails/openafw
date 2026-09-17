//! The closed `reject_value` predicate vocabulary (OGR 1.4 local-redaction,
//! "The predicate vocabulary"). Ported from AIRS `policy-engine/valuePredicates.ts`
//! — the shapes and nouns are the runtime's, verbatim, because the built-in
//! rules' `nomatch` examples were written against exactly these.
//!
//! Each predicate is one bounded pass over the SPAN. Predicates are ANDed as
//! "reject if any fires". A predicate this engine cannot evaluate must disable
//! the whole rule (see `ruleset::compile`), never be read as "no filter".

use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use serde_json::Value;

/// A run of characters that means "somebody has not filled this in yet".
pub const PLACEHOLDER_SHAPES: &[&str] = &[
    r"\*{3,}",
    r"x{3,}",
    r"\$\{",
    "<",
    ">",
    r"%[sd]",
    r"\.{3,}",
    "…",
    "changeme",
    "placeholder",
    "redacted",
    r"your[_\-]?password",
    r"your[_\-]",
    "example",
    r"\$",
    r"change[_\-]?me",
    r"dev[_\-]only",
    r"no[_\-]check",
    r"test[_\-](?:key|token|secret|pass)",
    r"(?:some|target|dummy|sample|fake)[_\-](?:key|token|secret|pass)",
];

const SECRET_NOUNS: &str = "password|passwd|pwd|secret|api[_\\-]?key|access[_\\-]?token|auth[_\\-]?token|\
client[_\\-]?secret|refresh[_\\-]?token|id[_\\-]?token|session[_\\-]?token|\
private[_\\-]?key|key[_\\-]?material|raw[_\\-]?secret|bearer|token";

/// Longest value any predicate will look at (in chars).
pub const MAX_VALUE_CHARS: usize = 4096;

fn ci(source: &str) -> Regex {
    RegexBuilder::new(source).case_insensitive(true).build().expect("static predicate regex")
}

static PLACEHOLDER_RE: LazyLock<Regex> = LazyLock::new(|| ci(&format!("^(?:{})", PLACEHOLDER_SHAPES.join("|"))));
static PLACEHOLDER_ANYWHERE_RE: LazyLock<Regex> = LazyLock::new(|| ci(&format!("(?:{})", PLACEHOLDER_SHAPES.join("|"))));
static SECRET_NOUN_RE: LazyLock<Regex> = LazyLock::new(|| ci(&format!("^(?:{SECRET_NOUNS})(?:[^A-Za-z0-9_]|$)")));
static VARIABLE_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+|\[[^\]]*\])+$").unwrap());
static IDENT_ONLY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^[A-Za-z0-9_$.\[\]"']+$"#).unwrap());
static IDENT_PATH_MARK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[._\[]").unwrap());
static CONTAINS_SECRET_NOUN_RE: LazyLock<Regex> = LazyLock::new(|| ci(&format!("(?:{SECRET_NOUNS})")));
static STRUCTURAL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[(){}\[\]]").unwrap());

#[derive(Debug, Clone)]
pub enum ValuePart {
    Whole,
    /// Everything after the FIRST `sep`; the whole value when it does not occur.
    After(String),
    /// Everything before the first `sep`.
    Before(String),
}

#[derive(Debug, Clone)]
pub enum Predicate {
    Placeholder { anywhere: bool },
    SecretNoun,
    VariableReference,
    NamesSecret,
    Structural,
    LowEntropy { min: f64 },
    /// Compiled on the linear engine; a pattern it refuses disables the rule.
    Matches(Regex),
}

#[derive(Debug, Clone)]
pub struct CompiledReject {
    pub part: Option<ValuePart>,
    pub predicate: Predicate,
}

/// Shannon entropy in bits per character.
pub fn shannon_bits(value: &str) -> f64 {
    if value.is_empty() {
        return 0.0;
    }
    let mut counts: std::collections::HashMap<char, usize> = std::collections::HashMap::new();
    let mut n = 0usize;
    for ch in value.chars() {
        *counts.entry(ch).or_insert(0) += 1;
        n += 1;
    }
    let n = n as f64;
    let mut bits = 0.0;
    for &c in counts.values() {
        let p = c as f64 / n;
        bits -= p * p.log2();
    }
    bits
}

fn part_of<'a>(value: &'a str, part: Option<&ValuePart>) -> &'a str {
    match part {
        None | Some(ValuePart::Whole) => value,
        Some(ValuePart::After(sep)) => match value.find(sep.as_str()) {
            Some(i) => &value[i + sep.len()..],
            None => value,
        },
        Some(ValuePart::Before(sep)) => match value.find(sep.as_str()) {
            Some(i) => &value[..i],
            None => value,
        },
    }
}

fn bounded(value: &str) -> &str {
    if value.len() <= MAX_VALUE_CHARS {
        return value;
    }
    match value.char_indices().nth(MAX_VALUE_CHARS) {
        Some((i, _)) => &value[..i],
        None => value,
    }
}

/// Does any rule REJECT this value?
pub fn value_rejected(value: &str, rejects: &[CompiledReject]) -> bool {
    if rejects.is_empty() {
        return false;
    }
    let value = bounded(value);
    for r in rejects {
        let target = part_of(value, r.part.as_ref());
        let hit = match &r.predicate {
            Predicate::Placeholder { anywhere: true } => PLACEHOLDER_ANYWHERE_RE.is_match(target),
            Predicate::Placeholder { anywhere: false } => PLACEHOLDER_RE.is_match(target),
            Predicate::SecretNoun => SECRET_NOUN_RE.is_match(target),
            Predicate::VariableReference => VARIABLE_REF_RE.is_match(target),
            Predicate::NamesSecret => {
                IDENT_ONLY_RE.is_match(target)
                    && IDENT_PATH_MARK_RE.is_match(target)
                    && CONTAINS_SECRET_NOUN_RE.is_match(target)
            }
            Predicate::Structural => STRUCTURAL_RE.is_match(target),
            Predicate::LowEntropy { min } => shannon_bits(target) < *min,
            Predicate::Matches(re) => re.is_match(target),
        };
        if hit {
            return true;
        }
    }
    false
}

/// Compile a rule's served `reject_value` list. Any entry this engine cannot
/// evaluate is an `Err(reason)` — the caller disables the rule by id.
pub fn compile_rejects(raw: Option<&Value>, rule_id: &str) -> Result<Vec<CompiledReject>, String> {
    let Some(raw) = raw else { return Ok(Vec::new()) };
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let Some(list) = raw.as_array() else {
        return Err(format!("{rule_id}: reject_value is not a list"));
    };
    let mut out = Vec::with_capacity(list.len());
    for (i, entry) in list.iter().enumerate() {
        let Some(entry) = entry.as_object() else {
            return Err(format!("{rule_id}: reject_value[{i}] is not an object"));
        };
        let part = match entry.get("part") {
            None | Some(Value::Null) => None,
            Some(p) => {
                let Some(p) = p.as_object() else {
                    return Err(format!("{rule_id}: reject_value[{i}]: bad part"));
                };
                let of = p.get("of").and_then(Value::as_str).unwrap_or("");
                let sep = p.get("sep").and_then(Value::as_str);
                match (of, sep) {
                    ("whole", _) => Some(ValuePart::Whole),
                    ("after", Some(s)) => Some(ValuePart::After(s.to_string())),
                    ("before", Some(s)) => Some(ValuePart::Before(s.to_string())),
                    ("after" | "before", None) => {
                        return Err(format!("{rule_id}: reject_value[{i}]: part without a sep"))
                    }
                    (other, _) => return Err(format!("{rule_id}: reject_value[{i}]: unknown part {other:?}")),
                }
            }
        };
        let Some(pred) = entry.get("predicate").and_then(Value::as_object) else {
            return Err(format!("{rule_id}: reject_value[{i}] has no predicate"));
        };
        let kind = pred.get("kind").and_then(Value::as_str).unwrap_or("");
        let predicate = match kind {
            "placeholder" => Predicate::Placeholder {
                anywhere: pred.get("anywhere").and_then(Value::as_bool).unwrap_or(false),
            },
            "secret_noun" => Predicate::SecretNoun,
            "variable_reference" => Predicate::VariableReference,
            "names_secret" => Predicate::NamesSecret,
            "structural" => Predicate::Structural,
            "low_entropy" => match pred.get("min").and_then(Value::as_f64) {
                Some(min) if min.is_finite() => Predicate::LowEntropy { min },
                _ => return Err(format!("{rule_id}: reject_value[{i}]: low_entropy without a finite min")),
            },
            "matches" => {
                let Some(pattern) = pred.get("pattern").and_then(Value::as_str) else {
                    return Err(format!("{rule_id}: reject_value[{i}]: matches without a pattern"));
                };
                let flags = pred.get("flags").and_then(Value::as_str).unwrap_or("");
                if flags.chars().any(|c| !"ims".contains(c)) {
                    return Err(format!("{rule_id}: reject_value[{i}]: matches flags {flags:?} outside ims"));
                }
                let re = RegexBuilder::new(pattern)
                    .case_insensitive(flags.contains('i'))
                    .multi_line(flags.contains('m'))
                    .dot_matches_new_line(flags.contains('s'))
                    .build()
                    .map_err(|e| format!("{rule_id}: reject_value[{i}]: matches pattern refused by the linear engine: {e}"))?;
                Predicate::Matches(re)
            }
            other => return Err(format!("{rule_id}: reject_value[{i}]: unknown predicate kind {other:?}")),
        };
        out.push(CompiledReject { part, predicate });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejects(json: &str) -> Vec<CompiledReject> {
        compile_rejects(Some(&serde_json::from_str(json).unwrap()), "t").unwrap()
    }

    #[test]
    fn placeholder_anchored_and_anywhere() {
        let anchored = rejects(r#"[{"predicate":{"kind":"placeholder"}}]"#);
        assert!(value_rejected("changeme", &anchored));
        assert!(value_rejected("<YOUR_TOKEN>", &anchored));
        assert!(!value_rejected("kqFb...BxxM", &anchored));
        let anywhere = rejects(r#"[{"predicate":{"kind":"placeholder","anywhere":true}}]"#);
        assert!(value_rejected("kqFb...BxxM", &anywhere));
        assert!(value_rejected("dev-only-change-me", &anywhere));
    }

    #[test]
    fn names_secret_is_a_conjunction() {
        let r = rejects(r#"[{"predicate":{"kind":"names_secret"}}]"#);
        assert!(value_rejected("DB_PASSWORD", &r));
        assert!(value_rejected("cfg.db.pwd", &r));
        assert!(!value_rejected("password", &r)); // no path mark
        assert!(!value_rejected("hunter2_x", &r)); // no noun
    }

    #[test]
    fn part_after_separator() {
        let r = rejects(r#"[{"part":{"of":"after","sep":":"},"predicate":{"kind":"secret_noun"}}]"#);
        assert!(value_rejected("user:password", &r));
        assert!(!value_rejected("user:Storewave@2022", &r));
    }

    #[test]
    fn unknown_kind_is_an_error_not_no_filter() {
        assert!(compile_rejects(Some(&serde_json::json!([{ "predicate": { "kind": "future" } }])), "t").is_err());
    }

    #[test]
    fn entropy() {
        assert!(shannon_bits("aaaa") < 0.01);
        assert!(shannon_bits("abcd") > 1.9);
    }
}
