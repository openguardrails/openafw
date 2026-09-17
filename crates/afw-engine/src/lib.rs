//! OpenAFW secrets engine — an implementation of OGR 1.4 local redaction
//! (`openguardrails/specification/local-redaction.md`) for a local gateway.
//!
//! - [`ruleset`]: the served `ogr-re-1` ruleset, compiled and self-verified.
//! - [`predicates`]: the closed `reject_value` vocabulary.
//! - [`session`]: the value ↔ token map and the per-response restore scope.
//! - [`mask`]: outbound masking of text and JSON bodies.
//! - [`restore`]: whole-token restore, plain and streaming.
//! - [`sse`]: frame-level SSE rewriting per provider protocol.

pub mod mask;
pub mod predicates;
pub mod reassemble;
pub mod restore;
pub mod ruleset;
pub mod session;
pub mod sse;

pub use mask::{mask, mask_cached, mask_value, mask_value_cached, tokens_present, MaskCache, MaskResult, Minted, WalkReport};
pub use restore::{restore, restore_value, tokens_in, Encode, RestoreReport, RestoreResult};
pub use ruleset::{compile, CompiledRuleset, Ruleset, DEFAULT_TIERS};
pub use session::{minter_letter, set_minter_letter, RestoreKeys, SessionMap, TokenFormat};
pub use reassemble::Reassembler;
pub use sse::{Protocol, Stream, StreamReport};

/// The ruleset snapshot shipped with the free build (design §9): the AIRS
/// built-in secrets rules in `GET /v1/rules` wire shape.
pub const BUILTIN_RULESET_JSON: &str = include_str!("../../../rules/builtin-secrets.json");

pub fn builtin_ruleset() -> Ruleset {
    Ruleset::from_json(BUILTIN_RULESET_JSON).expect("bundled ruleset parses")
}
