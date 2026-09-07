# Bidirectional parity scope — 2026-09-07

The latest user instruction replaces the broader original implementation plan:
ship the reverse counterpart of existing forward behavior, and track shared gaps
as issues rather than introducing reverse-only capabilities. Current live results are in
[production parity acceptance](production-parity.md). Shared follow-ups are
[#45](https://github.com/dean0x/subswitch/issues/45), [#46](https://github.com/dean0x/subswitch/issues/46),
[#47](https://github.com/dean0x/subswitch/issues/47), and [#48](https://github.com/dean0x/subswitch/issues/48).

| Area | Existing Claude Code → Codex | This change: Codex → Claude |
| --- | --- | --- |
| Routing | Canonical registry, aliases, model-based selection; unmatched Anthropic traffic passes through | Claude registry/aliases; unmatched OpenAI traffic passes through; native collaboration namespace compatibility |
| Native ownership | Claude Code owns agents/tools/permissions | Codex owns agents/tools/permissions; native HTTP and WebSockets required |
| Authentication | Existing subscription store, refresh, one 401 refresh retry; no API billing fallback | Existing Claude subscription store (Keychain/file), refresh, bounded 401 retry; documented native identity preamble |
| Translation | Text/instructions, function tools/results, effort, SSE/non-streaming and errors | Corresponding Responses/Responses-lite forms, plus reversible native namespace/freeform encoding |
| State | Bounded process-local reasoning cache | Bounded process-local continuation state and authenticated thinking replay; missing state fails explicitly |
| Setup | Init, preview/non-interactive modes, preserve unrelated settings; no undo | Equivalent Codex init and preview; global native endpoint configuration requires a user-level SubSwitch fallback |
| Diagnostics | Doctor, model listing, startup/health, content-free logs | Direction-aware equivalents and native model discovery |
| Not in this change | Durable restart/resume, translated compaction, setup undo, API-key auth for translation, broad content/hosted-tool extensions | Track these for both directions; preserve raw same-provider traffic where no translation is needed |

No native binaries are patched or downgraded. No production setup on this machine
is changed by development tests; native runs use separate directories and ports.
