//! The secret ruleset: the `GET /v1/rules` wire shape, compiled and VERIFIED in
//! this engine. A rule that does not compile, whose `reject_value` this engine
//! cannot evaluate, or whose own `examples` fail here is disabled by id with the
//! reason — never run in the state the failure left it — and the rest run.
//!
//! Patterns are dialect `ogr-re-1` (fixed-width lookbehind, numbered groups,
//! ASCII classes, no `\b \d \w`). They are compiled with `fancy-regex`, which
//! delegates to the linear `regex` engine when a pattern uses no lookaround
//! and backtracks only when it must — the same "linear when possible" policy
//! AIRS runs. ⚠️ Pattern sources are byte-identical to what the runtime serves;
//! they were tuned there on real traffic, and a "tidier" pattern here is a
//! different rule.

use serde::Deserialize;
use serde_json::Value;

use crate::predicates::{compile_rejects, value_rejected, CompiledReject};

#[derive(Debug, Clone, Deserialize)]
pub struct RulePattern {
    pub id: String,
    pub source: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Examples {
    #[serde(default)]
    pub r#match: Vec<String>,
    #[serde(default)]
    pub nomatch: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub id: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default = "default_tier")]
    pub tier: String,
    #[serde(default)]
    pub flags: String,
    pub patterns: Vec<RulePattern>,
    /// 1-based capturing group that IS the span; absent ⇒ the whole match.
    #[serde(default)]
    pub group: Option<u32>,
    /// Read as open JSON and compiled by hand so an unknown predicate is a
    /// visible failure, not a deserialisation error that drops the ruleset.
    #[serde(default)]
    pub reject_value: Option<Value>,
    #[serde(default)]
    pub examples: Examples,
}

fn default_tier() -> String {
    "strong".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct Ruleset {
    pub id: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub dialect: String,
    pub rules: Vec<Rule>,
}

/// The `{"ruleset": …}` envelope `GET /v1/rules` answers with.
#[derive(Debug, Clone, Deserialize)]
pub struct RulesetEnvelope {
    pub ruleset: Ruleset,
}

impl Ruleset {
    /// Parse either the bare ruleset or its `{"ruleset": …}` envelope.
    pub fn from_json(text: &str) -> Result<Ruleset, String> {
        if let Ok(env) = serde_json::from_str::<RulesetEnvelope>(text) {
            return Ok(env.ruleset);
        }
        serde_json::from_str::<Ruleset>(text).map_err(|e| format!("ruleset does not parse: {e}"))
    }
}

#[derive(Debug)]
pub struct CompiledPattern {
    pub id: String,
    pub re: fancy_regex::Regex,
}

#[derive(Debug)]
pub struct CompiledRule {
    pub id: String,
    pub category: String,
    pub tier: String,
    pub group: Option<usize>,
    pub patterns: Vec<CompiledPattern>,
    pub rejects: Vec<CompiledReject>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisabledRule {
    pub id: String,
    pub reason: String,
}

#[derive(Debug)]
pub struct CompiledRuleset {
    pub id: String,
    pub dialect: String,
    /// Rules that compiled AND passed their own examples, in served order.
    pub rules: Vec<CompiledRule>,
    pub disabled: Vec<DisabledRule>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpanHit {
    pub start: usize,
    pub end: usize,
    /// The pattern id within the rule.
    pub pattern: String,
}

pub const DEFAULT_TIERS: &[&str] = &["strong", "heuristic"];

/// Every span one compiled rule claims in `text`, with `reject_value`
/// applied to the SPAN (the group where one is declared).
pub fn rule_spans(rule: &CompiledRule, text: &str) -> Vec<SpanHit> {
    let mut out = Vec::new();
    for p in &rule.patterns {
        for caps in p.re.captures_iter(text) {
            let Ok(caps) = caps else { break }; // backtrack limit: this pattern yields nothing more
            let Some(whole) = caps.get(0) else { continue };
            if whole.start() == whole.end() {
                continue;
            }
            let span = match rule.group {
                Some(g) => match caps.get(g) {
                    Some(m) => Span { start: m.start(), end: m.end() },
                    None => continue,
                },
                None => Span { start: whole.start(), end: whole.end() },
            };
            if span.end <= span.start {
                continue;
            }
            if !rule.rejects.is_empty() && value_rejected(&text[span.start..span.end], &rule.rejects) {
                continue;
            }
            out.push(SpanHit { start: span.start, end: span.end, pattern: p.id.clone() });
        }
    }
    out
}

fn flag_prefix(flags: &str) -> Result<String, String> {
    if flags.chars().any(|c| !"ims".contains(c)) {
        return Err(format!("flags {flags:?} outside the ogr-re-1 set ims"));
    }
    if flags.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!("(?{flags})"))
    }
}

/// Compile a served ruleset and run every rule's examples in THIS engine.
pub fn compile(ruleset: &Ruleset, tiers: &[&str]) -> CompiledRuleset {
    let mut rules = Vec::new();
    let mut disabled = Vec::new();
    let mut skipped = Vec::new();
    for rule in &ruleset.rules {
        if !tiers.contains(&rule.tier.as_str()) {
            skipped.push(rule.id.clone());
            continue;
        }
        match compile_rule(rule) {
            Ok(c) => rules.push(c),
            Err(reason) => disabled.push(DisabledRule { id: rule.id.clone(), reason }),
        }
    }
    CompiledRuleset { id: ruleset.id.clone(), dialect: ruleset.dialect.clone(), rules, disabled, skipped }
}

fn compile_rule(rule: &Rule) -> Result<CompiledRule, String> {
    let prefix = flag_prefix(&rule.flags)?;
    let mut patterns = Vec::with_capacity(rule.patterns.len());
    for p in &rule.patterns {
        let re = fancy_regex::Regex::new(&format!("{prefix}{}", p.source))
            .map_err(|e| format!("pattern {} does not compile: {e}", p.id))?;
        patterns.push(CompiledPattern { id: p.id.clone(), re });
    }
    let rejects = compile_rejects(rule.reject_value.as_ref(), &rule.id)?;
    let compiled = CompiledRule {
        id: rule.id.clone(),
        category: rule.category.clone(),
        tier: rule.tier.clone(),
        group: rule.group.filter(|g| *g > 0).map(|g| g as usize),
        patterns,
        rejects,
    };
    verify_examples(&compiled, &rule.examples)?;
    Ok(compiled)
}

fn verify_examples(rule: &CompiledRule, examples: &Examples) -> Result<(), String> {
    for text in &examples.r#match {
        if rule_spans(rule, text).is_empty() {
            return Err(format!("match example yielded no span: {text:?}"));
        }
    }
    for text in &examples.nomatch {
        if !rule_spans(rule, text).is_empty() {
            return Err(format!("nomatch example yielded a span: {text:?}"));
        }
    }
    Ok(())
}
