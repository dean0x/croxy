# Live native Codex → Claude prototype

This records the prototype stage. The [production parity gateway](production-parity.md)
now implements the scoped feature in `serve`, setup and diagnostics, including real
native authentication and model discovery.

Verified 2026-09-07, Asia/Jerusalem, with native Codex 0.153.4. The original
live-provider question now has a positive result: an OpenAI parent can spawn a
Claude-backed native Codex child, Codex executes its tool, Claude consumes the
result, and the answer reaches the parent. A follow-up on the same child works.

This is an isolated source-only prototype, **not production reverse support**.

## Reproduction

```sh
# Direct subscription tool call and unpredictable tool-result continuation:
node --import tsx e2e/gates/claude-tool-contract.ts

# Actual native Codex with a scripted parent and live Claude child:
node --import tsx e2e/gates/native-reverse.ts

# Live OpenAI parent + live Claude child, including a follow-up:
node --import tsx e2e/gates/native-reverse.ts --live-parent --followup
node --import tsx e2e/gates/native-reverse.ts --live-parent --http --followup

# Native Codex itself authenticated through the existing subscription:
node --import tsx e2e/gates/native-reverse.ts --live-parent --followup --native-subscription
```

The ordinary runner uses a fabricated API credential between native Codex and the
local test proxy. Both actual upstreams use explicitly selected subscription
credentials. `--native-subscription` additionally puts the native Codex client in
subscription mode, using a restricted temporary copy of its existing credentials
with the refresh token removed. It uses the subscription ingress path. Neither
variant selects API billing or introduces another login.

## Results

| Check | Result |
| --- | --- |
| Direct Claude function call and result continuation | Pass; both requests HTTP 200, correct tool/arguments and exact unpredictable returned value |
| Native v2, scripted parent, live Claude, WebSockets | Pass; two Claude requests, native tool result and parent delivery |
| Native v2, scripted parent, live Claude, HTTP fallback | Pass; five HTTP requests through the ingress |
| Native v2, live OpenAI parent + live Claude child, WebSockets | Pass; tool/result, child answer and parent delivery |
| Live parent/child with same-child follow-up, WebSockets | Pass; five OpenAI requests, four Claude requests, two WebSocket connections |
| Live parent/child with same-child follow-up, HTTP fallback | Pass; nine HTTP requests, five OpenAI and four Claude requests |
| Native subscription authentication, live parent/child + follow-up, WebSockets | Pass; native Codex exit 0, all nine upstream calls HTTP 200 |
| Existing Claude Code → OpenAI flow, concurrent with reverse HTTP follow-up | Pass; two translated requests and real Read continuation |

Each child must read an unpredictable value from `check.txt` using its native
code/tool surface. Follow-up tests require reading a second unpredictable value
from `followup.txt`. The values are absent from prompts. Success requires seeing
the native tool result, Claude's answer, and delivery to the parent; HTTP 200 alone
does not count. All models and tool execution are real in `--live-parent` runs.
Model catalogs and role configuration are isolated test fixtures, not production
model discovery.

## Implementation and corrections

- [Request/response adapter](reverse-adapter.ts): namespaced functions and freeform
  tools use deterministic wire names; original call names/types are restored for
  Codex execution. Instructions and message text are not renamed or moved to
  lower-priority user turns. Unsupported content/history produces explicit errors.
- [Thinking state](reverse-state.ts): AES-256-GCM envelopes carry exact Claude
  thinking/signatures and their associated output through opaque Responses items.
  The adapter verifies replayed output identities before restoring the original
  assistant blocks. Wrong keys and altered history fail explicitly.
- The first native run stopped on an unhandled thinking block. Sonnet 5 enables
  adaptive thinking by default; the adapter now preserves those blocks, including
  empty visible thinking with a signature. [Claude migration documentation](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide)
- A later run reached the child answer but failed parent delivery because the
  emitted Responses usage object lacked required fields. Correct input/output/total
  counts, including cache accounting, fixed the retries and delivery failure.

The upstream calls are currently buffered before native events are emitted.
This proves protocol/tool orchestration, not production incremental streaming.
The state key and continuation map belong to the isolated run. A fresh codec with
the same key is covered by tests, but real proxy restart/session resume is not yet
implemented or certified.

## Identity and isolation

An initial isolated native Claude control supplies its identity system preamble
in memory. The direct Claude adapter retains that preamble and supplies the Codex
task, tool definitions, and conversation. It does not synthesize a billing marker,
copy a native user-agent, or rewrite product names in instructions. Native Claude
does not execute the Codex child's tools or run its agent loop.

The working path still makes a native identity claim. The original plan excluded
spoofing workarounds, so whether to include this explicitly documented behavior in
production was asked as a scope decision. No answer has been assumed. These live
results do not establish Anthropic's support commitment or which quota was billed.

All client configuration and test files are temporary, with separate loopback
ports and bounded processes. Captures, credentials, tool output and signatures
are not logged. The real shared credential stores and running user sessions are
left unchanged. Production `serve` still exposes only the opt-in raw Codex ingress.

## Remaining work

1. Resolve production subscription identity behavior against the original scope.
2. Production provider authentication/refresh, ingress-aware registry and discovery.
3. Complete translation coverage, incremental streaming, cancellation, typed errors
   and resource bounds across HTTP and WebSockets.
4. Durable keys/continuations, real restart/resume and compaction, including
   cross-provider opaque-history boundaries.
5. Setup/undo, global config layering, diagnostics, and native v1/v2 release matrix.
6. Explicit API-mode validation with real API credentials; no such billing mode has
   been selected or silently substituted in these tests.

Verification: typechecking, all **793 tests**, and the packaged-install smoke test
pass. The eight added tests cover tool round trips, namespace collisions,
malformed/truncated output, opaque state, image results, usage/events, authenticated
thinking replay and reasoning effort. Source-only probes are excluded from the
published tarball. These checks do not make the unfinished production feature ready.
