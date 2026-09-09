# Exact constraints and the alternative now demonstrated

The core production flow is now implemented and verified. See
[production parity acceptance](production-parity.md); the remaining shared gaps are
tracked in issues #45–#48. This file retains the earlier research chronology.

**Update, 2026-09-07:** the [live reverse prototype](live-reverse.md) now passes
OpenAI parent → native Claude-backed Codex child → native tool/result → parent,
including same-child follow-up, both transports, and native subscription auth.
The discovered preamble behavior is sufficient for these real Codex tasks. Its
production scope is pending; broad compatibility and release work remain.

## OpenAI: reserved schema rejected, reversible namespace translation works

The native `collaboration` schema requests encrypted task messages. OpenAI selects
the requested Sonnet child, but returns an opaque task. The model name remains
readable, so routing works; the task needed for Claude does not. SubSwitch has no
corresponding decryption key. Ports, aliases, WebSocket handling, and a local bridge
encryption key cannot recover plaintext from that payload.

The independent per-field test now establishes the precise rejection: setting
`encrypted` false **or removing it** returns HTTP 400 for each of `spawn_agent`,
`send_message`, and `followup_task`. Each error names the changed reserved function
and requires its configured schema. The unchanged control returns HTTP 200.

However, the same definitions under `subswitch_collaboration`, with the three
annotations false, are accepted and generate the exact readable Sonnet task.
The restriction is specific to the reserved namespace, not plaintext tool calling.

An experimental [namespace adapter](namespace-adapter.ts) now maps structured
definitions, tool choices, and replayed calls upstream, and restores native call
names and plaintext metadata downstream. It leaves prompt text and opaque reasoning
untouched, rejects namespace collisions, and rejects malformed or explicitly
encrypted calls. It does not patch Codex or select v1. The installed native Codex
v2 client passes its child/tool/parent/follow-up flow with this adapter and a fake
upstream over WebSockets and HTTP fallback. Live OpenAI schema, generation, and
history replay controls pass separately. The later live prototype integrates the
namespace adapter with a real Claude child; it is still not a production feature.

The tradeoff is explicit: collaboration traffic from an activated parent is adapted,
including OpenAI-to-OpenAI messages. An implementation must preserve this mapping
across every transport and replay. It cannot claim all parent traffic is unchanged.

The native runner also uncovered a fixture problem after Codex updated from 0.153.3
to 0.153.4: its test model cache still named the old client version. The unchanged
control failed too. The runner now stamps its fabricated catalog with the installed
version and runs that control before testing the namespace adapter. The client itself
is not changed or downgraded.

## Claude: native system identity affects direct subscription acceptance

The same subscription and Sonnet model work through unmodified native Claude,
including a subagent and real Read/tool-result continuation through SubSwitch.
Bridge-generated minimal Messages requests return HTTP 429, `rate_limit_error`, generic message `Error`,
without retry guidance or an identified spend-limit detail.

The failure persists across HTTPS/fetch, streaming/non-streaming, the beta query
endpoint, plain text without tools, and adaptive thinking with automatic tool choice.
It is therefore insufficient to blame forced tool choice or an unusable login.
Later [Pi/Hermes source research and controlled native-request reductions](provider-research.md)
isolate a concrete difference: with SubSwitch's own user-agent and the native beta
selection, a native-generated request succeeds after removing billing and account
metadata. Removing its native identity system preamble reproduces the generic 429.
A generic assistant preamble fails too. The reference clients explicitly supply
native identity statements; several also rewrite prompt content and tool names.

This narrows the failure to an observed request-content dependency. The internal
classification rule and charged quota remain unknown. Direct tool continuation
and specific real Codex tasks now pass; arbitrary workloads remain unverified. The identity-dependent examples
do not satisfy the original no-impersonation requirement. Neither blanket exhaustion
nor universal technical impossibility follows from these results.

There is a separate documented support boundary: Anthropic directs third-party
integrations to API authentication and restricts subscription credential
intermediation. That documentation does not prove the cause of this particular
error. [Credential-use documentation](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

## What would change the remaining path

| Angle | Effect and remaining work |
| --- | --- |
| Reversible namespace adapter | Demonstrates a route around the reserved-schema restriction while retaining native v2; integration, durable replay, and live mixed-provider validation remain |
| Explicit Anthropic API authentication | Uses the documented third-party authentication path; needs a valid API credential and live continuation test, incurs separate billing, and does not satisfy subscription-only usage |
| Approved direct subscription integration | Could retain the original authentication requirement; needs the exact supported request contract and successful continuation |
| Native Claude CLI/SDK child runtime | Native subscription inference works, but this introduces a second runtime and changes the requested pure protocol-bridge architecture |

The narrow impossibility is recovering the task from the existing opaque OpenAI
payload using only the bridge's available inputs. The wider integration is not
proved impossible: namespace translation is a demonstrated alternative. Claude
direct subscription use remains unresolved, not proved universally impossible.

No authentication fallback or namespace rewrite has been enabled in production.
The reverse provider adapters, durable state, setup/undo, and remaining release
matrix are still implementation work. A valid Anthropic API credential is currently
unavailable; an explicitly selected OpenAI API control previously returned HTTP 401.
