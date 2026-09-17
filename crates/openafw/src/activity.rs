//! The activity log (design §2 "活动" page): a bounded ring of request records
//! plus process counters. Never a value — only placeholders and rule ids.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
pub struct OgrDecision {
    pub decision: String,
    pub enforced: bool,
    pub findings: Vec<String>,
    pub event_id: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct OgrSummary {
    pub request: Option<OgrDecision>,
    pub response: Option<OgrDecision>,
    /// The runtime could not be reached for one or both halves; the step went unjudged (fail-open).
    pub unjudged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub id: u64,
    /// Unix milliseconds.
    pub at: u64,
    pub agent: String,
    pub protocol: String,
    pub path: String,
    pub model: String,
    pub status: u16,
    pub streamed: bool,
    /// `token=rule/pattern` per fresh mint.
    pub minted: Vec<String>,
    pub known: usize,
    pub tokens_in_context: usize,
    pub restored: usize,
    pub unresolved: Vec<String>,
    pub ms: u64,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ogr: Option<OgrSummary>,
}

#[derive(Debug)]
pub struct Log {
    ring: VecDeque<Record>,
    cap: usize,
}

impl Log {
    pub fn new(cap: usize) -> Self {
        Self { ring: VecDeque::with_capacity(cap), cap }
    }

    pub fn push(&mut self, r: Record) {
        if self.ring.len() >= self.cap {
            self.ring.pop_front();
        }
        self.ring.push_back(r);
    }

    pub fn recent(&self, n: usize) -> Vec<Record> {
        self.ring.iter().rev().take(n).cloned().collect()
    }

    pub fn update(&mut self, id: u64, f: impl FnOnce(&mut Record)) {
        if let Some(r) = self.ring.iter_mut().rev().find(|r| r.id == id) {
            f(r);
        }
    }
}

pub fn next_id() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Default)]
pub struct Counters {
    pub requests: AtomicU64,
    pub minted: AtomicU64,
    pub known: AtomicU64,
    pub restored: AtomicU64,
    pub unresolved: AtomicU64,
    pub errors: AtomicU64,
    pub events_sent: AtomicU64,
    pub evaluate_errors: AtomicU64,
    pub blocked: AtomicU64,
}

impl Counters {
    pub fn add(&self, r: &Record) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        self.minted.fetch_add(r.minted.len() as u64, Ordering::Relaxed);
        self.known.fetch_add(r.known as u64, Ordering::Relaxed);
        self.restored.fetch_add(r.restored as u64, Ordering::Relaxed);
        self.unresolved.fetch_add(r.unresolved.len() as u64, Ordering::Relaxed);
        if r.error.is_some() {
            self.errors.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "requests": self.requests.load(Ordering::Relaxed),
            "minted": self.minted.load(Ordering::Relaxed),
            "known": self.known.load(Ordering::Relaxed),
            "restored": self.restored.load(Ordering::Relaxed),
            "unresolved": self.unresolved.load(Ordering::Relaxed),
            "errors": self.errors.load(Ordering::Relaxed),
            "events_sent": self.events_sent.load(Ordering::Relaxed),
            "evaluate_errors": self.evaluate_errors.load(Ordering::Relaxed),
            "blocked": self.blocked.load(Ordering::Relaxed),
        })
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
