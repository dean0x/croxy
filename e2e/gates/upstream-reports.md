# Upstream compatibility reports — drafts, not submitted

Update: the [live prototype](live-reverse.md) passes the mixed-provider v2 flow and
follow-up with the native Claude preamble. The remaining Anthropic inquiry concerns
a supported production request/identity contract; basic technical tool continuation
is now demonstrated. No report has been submitted.

These reports describe the two unresolved Gate 1 contracts. They contain fabricated
test data and public schema information only. No credentials, account identifiers,
request IDs, prompts from user sessions, or encrypted payloads are included.

## OpenAI: supported plaintext collaboration contract for native Codex v2

### Problem and reproduction

A local protocol bridge needs to route a native Codex child to another model
provider while Codex retains agent orchestration, permissions, and tool execution.
The bridge cannot decrypt OpenAI-owned collaboration messages. It needs a supported
way to request readable arguments for `spawn_agent`, `send_message`, and
`followup_task`, and to return a known-plaintext child message to its OpenAI parent.

With Codex CLI 0.153.3, subscription authentication, and `gpt-6-astra`:

```sh
npm ci
npm run probe:compat -- --provider openai --model gpt-6-astra
```

The [native namespace fixture](../../test/fixtures/native/codex-0.153.3-collaboration.json)
was captured using an isolated fake upstream. The runner sends the entire namespace
as a native `additional_tools` input item to the Codex Responses endpoint. A fixed
request with the unchanged namespace returns HTTP 200 and a completed SSE response.
The identical request with only three `parameters.properties.message.encrypted`
values changed from `true` to `false` returns HTTP 400. The error identifies the
reserved `collaboration.followup_task` schema as not matching the configured schema.
The dependent generated-argument stage is not reached. A separate corrected
known-plaintext history check now passes with the unchanged native schema:

```sh
npm run probe:compat -- --provider openai --model gpt-6-astra --contract native-history
npm run probe:compat -- --provider openai --model gpt-6-astra --contract native-arguments
```

The installed client and backend accept `encrypted_function_args: []`, plaintext
`agent_message.content` arrays, and an `amsg`-prefixed message ID. The strings
`[plaintext arguments]` and `[plaintext]` were incorrectly inferred as wire values
in the earlier draft; they are log-redaction labels. The history probe is corrected.
In the separate outgoing-argument check, the model selects the requested Sonnet
child but returns an opaque task instead of the fixed readable message.

Native v1 and v2 parent/child/tool-result flows now pass against a fabricated
upstream through SubSwitch over WebSockets. V2 follow-up and HTTP fallback also
pass. These establish the native-client contracts, not cross-provider live inference.

The later per-field matrix rejects both false and omission independently for all
three tools. An ordinary `subswitch_collaboration` namespace instead accepts the
plaintext schemas and generates the exact readable task. A reversible experimental
adapter also passes the native Codex v2 fixture. This inquiry now concerns retaining
the reserved namespace specifically, rather than claiming every integration route
is blocked. See [the updated constraints](blockers.md).

### Requested contract

What supported native Codex configuration or request field opts these collaboration
messages into plaintext while keeping v2 orchestration and reserved schemas valid?
Does it apply to both subscription and explicitly API-authenticated Codex?
The incoming child-to-parent plaintext replay shape is already verified; the
remaining question is the outgoing task-generation contract.

The public [beta Responses reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)
describes text-bearing agent messages and server-hosted multi-agent configuration.
That does not establish a local Codex plaintext opt-in. Server-hosted orchestration
would change the required architecture, so it is not a substitute for this contract.

### Resume criteria

Document and reproduce a supported backend-accepted contract, then verify readable
generated arguments and a child reply with real native v2 Codex. Preserve v1 support
where selected natively. No ciphertext relabeling, decryption, or forced downgrade.
Plaintext schema changes cannot be enabled on the strength of HTTP 200 for the
unchanged control alone.

## Anthropic: direct subscription compatibility and identity-sensitive HTTP 429

### Problem and reproduction

The proposed bridge calls Messages directly while Codex executes the returned
tools. It does not run Claude Code as the agent executor. Before implementation,
we need a supported authentication contract and a successful tool-result continuation.

Environment: macOS, Node 22.22.3, Claude Code 2.1.261. Read the user's existing
subscription credential from the native default Keychain service, then run:

```sh
npm run probe:compat -- --provider claude --model claude-sonnet-5
```

The probe uses the official Messages endpoint, bearer authentication,
`anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`, and its own
SubSwitch probe user agent. It sends a fixed forced `echo` call with `max_tokens:
128`. It does not impersonate Claude Code or change credentials. HTTP 429 returns
`rate_limit_error`, generic message `Error`, and no `Retry-After`. No explicit spend
limit detail or inspected rate-limit reset guidance was present. The continuation
was not attempted after rejection.

A separate unmodified native Claude Code control, using the same subscription and
model from an empty temporary directory with safe mode and no tools, succeeded with
the fixed answer `gate-ok`. A later isolated Sonnet parent → Sonnet child → Read →
parent test also passed through SubSwitch, including five Messages requests and a
real tool-result continuation. The direct request still failed with HTTPS and fetch,
streaming and non-streaming, and the beta query endpoint.
Direct plain-text requests without tools and adaptive-thinking requests with
automatic tool choice also returned 429. The existing Claude Code → OpenAI child
tool-result flow passed separately and concurrently with the isolated native Codex
v2 fixture; this does not test the reverse provider adapter.
This rules out treating native account access as universally unavailable.
A later [system-identity control and Pi/Hermes source comparison](provider-research.md)
narrows the difference further: a native-generated request with SubSwitch's own
user-agent and native betas succeeds without billing/account metadata, while
removing its native identity system block produces the generic 429. The internal
classification policy and billed quota are not established by this experiment.

### Requested contract

The [credential-use documentation](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
restricts subscription credential intermediation and directs third-party products
to API authentication. Is there an approved direct subscription integration for a
user-operated local protocol bridge? If so, what request/authentication contract is
supported, including system identity requirements, and how should this specific 429 be diagnosed? If not, subscription mode
cannot be advertised as supported under the current requirement.

### Resume criteria

Establish a supported subscription integration, then pass both the forced tool call
and its tool-result continuation without native-client impersonation. Otherwise
the user must explicitly revise the subscription requirement before an API-only
release could be pursued. API mode has not been live-certified, would incur separate
billing, and would still require integrating and validating the experimental
OpenAI namespace adapter with the reverse provider.
An explicitly selected OpenAI API control returned HTTP 401; no Claude API key was
available. Neither API combination is certified.

## Work disposition

Keep the independently tested Codex raw passthrough disabled by default. Do not
activate reverse setup, dispatch Claude requests, or rewrite collaboration schemas
until their prerequisites pass. The ordinary namespace adapter can be investigated
independently; an OpenAI inquiry is specific to retaining its reserved schema.
Claude's supported authentication contract still needs resolution. These drafts
have not been sent. The full release matrix remains unverified.
