# Changelog

## 1.0.0 — 2026-09-17

A full rewrite in Rust. OpenAFW is now a local AI firewall for coding agents:
a pass-through proxy that replaces secrets with placeholders before a request
leaves the machine, and puts them back when the reply comes home.

Everything before this release was a different program — a TypeScript agent
router with model fusion and provider switching. That code is not carried
forward; it remains in the git history and in the `v0.11.3` and earlier tags
and releases, and `@openafw/openafw@0.11.3` stays on npm.

### The firewall

- Pass-through proxy on `127.0.0.1:4141` for Anthropic Messages, OpenAI Chat
  Completions, OpenAI Responses and Gemini, streaming included. Bodies are
  masked on the way out and restored on the way back; unknown protocols pass
  through byte-for-byte.
- `crates/afw-engine` — the OGR 1.4 local-redaction engine: ruleset compile
  with self-verification, `reject_value` predicates, session map, mask,
  restore, and SSE rewriting that survives a placeholder split across chunks.
- Placeholders are `OGRK` + a minter letter + seven digits (`OGRKF0000001`,
  twelve characters). The shape and the namespacing letter were chosen by
  measurement across five model setups — see `docs/placeholder-experiment.md`.
- The local machine is the trusted zone: your terminal, your tools and your
  files still see real values. Logs never contain them.

### Keys and agents

- Encrypted key vault (AES-256-GCM) at `~/.openafw/vault.bin`, with profiles
  and a per-agent local token.
- `openafw protect claude|codex|gemini|opencode|openclaw|hermes` writes that
  agent's own config and keeps a byte-exact backup; `unprotect` restores it
  byte for byte.
- `POST /__afw/api/mask` on loopback for local plugins — mints placeholders,
  never reveals values.

### Running it

- `openafw service install|status|uninstall` — launchd on macOS, systemd
  `--user` on Linux, Task Scheduler on Windows. Uninstall removes exactly
  what install wrote.
- `crates/openafw-desktop` — a Tauri tray/menu-bar app with the daemon
  in-process; it attaches to an already-listening service rather than
  starting a second one. Installers via `scripts/build-desktop.sh`.
- Status page at `http://127.0.0.1:4141/__afw/`, with one-click protect and
  unprotect per agent.

### OpenGuardrails

- `openafw connect` pulls served rulesets and reports per-step verdicts
  (`step/request` / `step/response`). Observe-only by default; `--ogr-enforce`
  refuses blocked steps.

### Seeing it work

- `--tap DIR` writes every provider-bound body so you can grep for the secret
  yourself, and `--mask false` gives you the unprotected baseline to compare
  against.

### Licence

- Relicensed to Apache-2.0. Earlier releases were MIT.
