# OpenAFW

A local AI firewall for coding agents. Point Claude Code, Codex, Gemini CLI,
OpenCode, OpenClaw or Hermes at `http://127.0.0.1:4141`; secrets in every
request are replaced by `OGRKF0000001`-style placeholders before they leave your
machine and put back when the model's reply comes home. The model, the relay
and the provider never see the value; your terminal, your tools and your
files still do.

Free and open source. Connects to [OpenGuardrails](https://openguardrails.com)
for the paid features (served rulesets, tool-call judgement, dashboards).
Design: [`docs/architecture.md`](docs/architecture.md).

## Status

Milestone 1 (2026-09-13): pass-through proxy with mask/restore for Anthropic
Messages, OpenAI Chat Completions and OpenAI Responses, streaming included.
Verified live with Claude Code: the model saw a 12-character placeholder, the
shell measured the 44-character key.

Also in: encrypted key vault with profiles and per-agent local tokens, a
persisted placeholder map, `openafw protect claude|codex|gemini|opencode|openclaw|hermes` (with byte-exact `unprotect`), a loopback `POST /__afw/api/mask` for local plugins (mint only, never reveal), a Gemini
decoder, a status page at `http://127.0.0.1:4141/__afw/`, and an OpenGuardrails
connection (`openafw connect`) for served rulesets and per-step verdicts
(`step/request` / `step/response`; observe by default, `--ogr-enforce` to refuse blocked steps). The placeholder
shape, and the minter letter that namespaces it, were chosen by measurement: `docs/placeholder-experiment.md`.

## Try it

```sh
cargo build --release
./target/release/openafw                    # 127.0.0.1:4141 → https://api.anthropic.com
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude
```

```sh
openafw profile add anthropic --provider anthropic --key-stdin   # paste the key, Enter
openafw agent set claude anthropic                                # mints claude's local token
openafw protect claude --profile anthropic                        # writes ~/.claude/settings.json
openafw status
```

`openafw --help` lists the rest: `--listen`, `--upstream`, `--upstream-key`,
`--rules`, `--strong-only`, `--hint`; `profile`, `agent`, `protect`, `unprotect`,
`connect`, `disconnect`, `forget-map`. Vault at `~/.openafw/vault.bin`
(AES-256-GCM; master key in `~/.openafw/master.key`, 0600). Logs never contain values.

## See the leak, and see it stop

The common leak is not the user pasting a key: it is the agent reading a
file that happens to contain one, after which the whole file content is
resent to the provider on every turn. `--tap DIR` writes every provider-bound
body so you can check for yourself; `--mask false` shows the baseline.

```
# .env holds STRIPE_SECRET_KEY=sk_live_…; ask Claude Code to fix a malformed line in it
openafw --mask false --tap /tmp/tap-off     # baseline: 2 of 5 provider-bound bodies contain the real key
openafw --tap /tmp/tap-on                   # firewall: 0 of 4 contain it; 2 contain OGRKF0000001 instead
```

Locally the file is fixed and still holds the real key, and the answer shown
in the terminal is restored — only the provider never sees the value.

## Run it at login, or as a desktop app

```sh
openafw service install     # launchd (macOS) / systemd --user (Linux) / Task Scheduler (Windows)
openafw service status
openafw service uninstall   # removes exactly what install wrote
```

`crates/openafw-desktop` is the Tauri shell: a menu-bar/tray icon
(open / pause / start at login / quit) and a window showing the same status
page, with the daemon in-process. If a service is already listening it
attaches instead of starting a second one. Build the installers with
`scripts/build-desktop.sh` (macOS `.app` + `.dmg`, Windows `.msi`, Linux
`.deb` + AppImage). macOS and Windows are the primary targets; the Linux
build works but the CLI plus the systemd user service is the primary
Linux path.

From the page you can protect an agent with one click — it writes that
agent's own config and keeps a byte-exact backup, the same as
`openafw protect`.

## Layout

- `crates/afw-engine` — the OGR 1.4 local-redaction engine: ruleset compile +
  self-verification, `reject_value` predicates, session map, mask, restore,
  SSE rewriting. `cargo test -p afw-engine` runs the OGR conformance corpus.
- `crates/openafw` — the daemon as a library plus the CLI.
- `crates/openafw-desktop` — the Tauri desktop shell (tray + window).
- `rules/builtin-secrets.json` — the bundled ruleset (AIRS built-ins, wire shape).
- `rules/conformance/` — the OGR local-redaction conformance corpus.

## Licence

Apache-2.0 — see [`LICENSE`](LICENSE). Releases up to `v0.11.3` were a
different program (a TypeScript agent router) under MIT; that code stays in
the git history and on npm as `@openafw/openafw`.
