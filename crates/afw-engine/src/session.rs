//! The value ↔ token map.
//!
//! OpenAFW keeps ONE map for the whole machine (design §5.3): value-stable
//! across sessions, agents and restarts, so a token the model learned before an
//! autocompact still restores afterwards. What bounds the model's reach is not
//! the map but the RESTORE SCOPE (`RestoreKeys`): a response may only restore
//! tokens that appeared in the request it answers.
//!
//! Persistence (encrypted, in the vault) is layered on top of this in-memory
//! structure; nothing here touches the disk.

use std::collections::HashMap;

/// The placeholder shape minted for secrets: **`OGRK` + a MINTER LETTER + seven
/// zero-padded digits**, twelve characters wide — `OGRKF0000001`.
///
/// The shape was measured (docs/placeholder-experiment.md, four rounds, five
/// model setups): anything that reads as an IDENTIFIER (`${OGR_SECRET_1}`,
/// `<…>`, `[[…]]`, `{{…}}`) is taken for an environment variable or an
/// unfilled template and rewritten; anything that reads as a VALUE is copied
/// byte for byte, and `OGRK…` copies best on the strictest harness.
///
/// ⚠️⚠️ **THE LETTER IS A NAMESPACE, AND IT EXISTS BECAUSE TWO MINTERS SHARING
/// ONE COUNTER SPACE FAIL AS A WRONG VALUE, SILENTLY** (2026-09-14, found by
/// the AIRS side). A host counter is per host and permanent; a runtime's is
/// per agent and expires. A body that carries no host token gives the runtime
/// a floor of zero, so both mint number 1 for DIFFERENT values; one context
/// then holds one token naming two secrets, and whichever side restores
/// splices the wrong one into a tool call. With a letter each side mints into
/// its own space, a foreign token is plain text to us, and the worst case
/// degrades to two names for one value — each independently restorable.
///
/// | letter | minter |
/// |---|---|
/// | `F` | OpenAFW, the local firewall (this crate) |
/// | `P` | an in-process harness plugin |
/// | `R` | an OGR runtime |
///
/// A future minter takes the next letter and needs no code change anywhere:
/// every reader matches `OGRK[A-Z][0-9X]{7}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TokenFormat {
    /// `OGRKF<nnnnnnn>` — the default: OpenAFW's own namespace.
    #[default]
    OgrKey,
    /// `${OGR_SECRET_<n>}` — the OGR 1.4 wire shape, kept for the conformance
    /// corpus and for bodies masked by a runtime that predates the change.
    OgrDollarBrace,
}

/// The letter naming THIS PROCESS as the minter. `F` is OpenAFW; the setter
/// exists because one process is exactly one minter, and a conformance runner
/// verifying a corpus another minter produced has to mint under that corpus's
/// declared letter to compare tokens at all.
static MINTER: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(b'F');

/// This process's minter letter (default `F`).
pub fn minter_letter() -> char {
    MINTER.load(std::sync::atomic::Ordering::Relaxed) as char
}

/// Set this process's minter letter. A deployment never calls this; a
/// conformance runner does, once, before it mints anything.
pub fn set_minter_letter(c: char) {
    assert!(c.is_ascii_uppercase(), "a minter letter is one upper-case ASCII letter");
    MINTER.store(c as u8, std::sync::atomic::Ordering::Relaxed);
}

impl TokenFormat {
    pub fn mint(self, n: u64) -> String {
        match self {
            TokenFormat::OgrKey => format!("OGRK{}{n:07}", minter_letter()),
            TokenFormat::OgrDollarBrace => format!("${{OGR_SECRET_{n}}}"),
        }
    }

    pub fn overflow(self) -> String {
        match self {
            TokenFormat::OgrKey => format!("OGRK{}XXXXXXX", minter_letter()),
            TokenFormat::OgrDollarBrace => "${OGR_SECRET_X}".to_string(),
        }
    }
}

/// Is this token one WE mint? Only our own namespace (and the legacy
/// letterless shape, which this build minted before the split) is ours to
/// restore or to refuse a tool call over; another minter's token is text.
pub fn is_ours(token: &str) -> bool {
    let Some(rest) = token.strip_prefix("OGRK") else { return token.starts_with("${OGR_SECRET_") };
    match rest.chars().next() {
        Some(c) if c == minter_letter() => true,
        // `OGRKXXXXXXXX` — the legacy overflow token, minted before the split
        Some('X') => rest.chars().all(|c| c == 'X'),
        Some(c) if c.is_ascii_uppercase() => false, // another minter's namespace
        // legacy: OGRK + digits, minted by this build before the split
        Some(c) if c.is_ascii_digit() => true,
        _ => false,
    }
}

/// The number inside a secret token of any shape this engine recognises.
pub fn token_number(token: &str) -> Option<u64> {
    if let Some(rest) = token.strip_prefix("OGRK") {
        let digits = match rest.chars().next() {
            Some(c) if c.is_ascii_uppercase() => &rest[1..],
            _ => rest,
        };
        return digits.parse().ok();
    }
    token.strip_prefix("${OGR_SECRET_")?.strip_suffix('}')?.parse().ok()
}

pub const DEFAULT_BOUND: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenGrant {
    pub token: String,
    /// True the first time this value was seen (a MINT).
    pub fresh: bool,
    pub restorable: bool,
}

#[derive(Debug, Default)]
pub struct SessionMap {
    by_value: HashMap<String, String>,
    by_token: HashMap<String, String>,
    counter: u64,
    bound: usize,
    format: TokenFormat,
    values_longest_first: Option<Vec<String>>,
}

impl SessionMap {
    pub fn new() -> Self {
        Self { bound: DEFAULT_BOUND, ..Default::default() }
    }

    pub fn with_format(format: TokenFormat) -> Self {
        Self { bound: DEFAULT_BOUND, format, ..Default::default() }
    }

    pub fn with_bound(bound: usize) -> Self {
        Self { bound, ..Default::default() }
    }

    pub fn format(&self) -> TokenFormat {
        self.format
    }

    pub fn len(&self) -> usize {
        self.by_value.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_value.is_empty()
    }

    /// Seed the allocator above a number already present in a body — two
    /// allocators share the `${OGR_SECRET_n}` namespace (spec: Placeholders).
    pub fn seed_above(&mut self, n: u64) {
        if n > self.counter {
            self.counter = n;
        }
    }

    /// Re-establish a persisted pair. Ignored if either side is already bound.
    pub fn insert_pair(&mut self, token: &str, value: &str) {
        if self.by_value.contains_key(value) || self.by_token.contains_key(token) {
            return;
        }
        if let Some(n) = token_number(token) {
            self.seed_above(n);
        }
        self.by_value.insert(value.to_string(), token.to_string());
        self.by_token.insert(token.to_string(), value.to_string());
        self.values_longest_first = None;
    }

    /// The token for a value, minting one when the value is new.
    pub fn token_for(&mut self, value: &str) -> TokenGrant {
        if let Some(t) = self.by_value.get(value) {
            return TokenGrant { token: t.clone(), fresh: false, restorable: true };
        }
        if self.by_value.len() >= self.bound {
            return TokenGrant { token: self.format.overflow(), fresh: true, restorable: false };
        }
        self.counter += 1;
        let token = self.format.mint(self.counter);
        self.by_value.insert(value.to_string(), token.clone());
        self.by_token.insert(token.clone(), value.to_string());
        self.values_longest_first = None;
        TokenGrant { token, fresh: true, restorable: true }
    }

    pub fn value_of(&self, token: &str) -> Option<&str> {
        self.by_token.get(token).map(String::as_str)
    }

    pub fn has_value(&self, value: &str) -> bool {
        self.by_value.contains_key(value)
    }

    /// Every known value, longest first — the order a substitution must run in.
    pub fn values_longest_first(&mut self) -> &[String] {
        if self.values_longest_first.is_none() {
            let mut v: Vec<String> = self.by_value.keys().cloned().collect();
            v.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
            self.values_longest_first = Some(v);
        }
        self.values_longest_first.as_deref().unwrap()
    }

    /// (token, value) pairs — for persistence and tests.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &str)> {
        self.by_token.iter().map(|(t, v)| (t.as_str(), v.as_str()))
    }

    /// The restore scope for one response: only `allowed` tokens, resolved now.
    pub fn restore_keys<'a, I: IntoIterator<Item = &'a str>>(&self, allowed: I) -> RestoreKeys {
        let mut keys = RestoreKeys::default();
        for t in allowed {
            if let Some(v) = self.by_token.get(t) {
                keys.insert(t, v);
            }
        }
        keys
    }

    /// Everything, as a restore scope — for tests and for a caller that has
    /// decided scope elsewhere.
    pub fn all_keys(&self) -> RestoreKeys {
        let mut keys = RestoreKeys::default();
        for (t, v) in &self.by_token {
            keys.insert(t, v);
        }
        keys
    }
}

/// The tokens a restorer may answer, longest first, with their values.
#[derive(Debug, Clone, Default)]
pub struct RestoreKeys {
    tokens: Vec<String>,
    values: HashMap<String, String>,
    sorted: bool,
}

impl RestoreKeys {
    pub fn from_pairs<'a, I: IntoIterator<Item = (&'a str, &'a str)>>(pairs: I) -> Self {
        let mut k = Self::default();
        for (t, v) in pairs {
            k.insert(t, v);
        }
        k
    }

    pub fn insert(&mut self, token: &str, value: &str) {
        if self.values.insert(token.to_string(), value.to_string()).is_none() {
            self.tokens.push(token.to_string());
            self.sorted = false;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }

    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    /// Tokens longest first — a key is never shadowed by its own prefix.
    pub fn tokens(&mut self) -> &[String] {
        if !self.sorted {
            self.tokens.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
            self.sorted = true;
        }
        &self.tokens
    }

    pub fn value_of(&self, token: &str) -> Option<&str> {
        self.values.get(token).map(String::as_str)
    }

    /// Sorted, frozen — what a stream restorer holds.
    pub fn freeze(mut self) -> Self {
        self.tokens();
        self
    }

    pub(crate) fn tokens_sorted(&self) -> &[String] {
        debug_assert!(self.sorted || self.tokens.len() < 2);
        &self.tokens
    }
}
