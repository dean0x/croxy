# Native usability acceptance — 2026-09-09

Ran against `feat/bidirectional-parity`, starting at `2bfd0d7` and then repeating
the affected scenarios with the usability fixes. Clients: Codex CLI 0.153.4,
Claude Code 2.1.266, Node 22.22.3 on macOS.

These runs used actual native clients and live model providers. Interactive setup
was driven through a real terminal; the longer Codex sessions were driven through
its native app-server protocol. The cancellation and continuation lifecycle follows
the [official app-server documentation](https://learn.chatgpt.com/docs/app-server).
Synthetic faults were used only for negative scenarios and the initial refresh-triggering 401.

## Results

| Scenario | Result | Observed control |
| --- | --- | --- |
| GPT-6 Astra → Sonnet, WebSockets | Pass | Actual file read, tool result, parent delivery, follow-up to the same child; prompt-cache reads observed. |
| GPT-6 Astra → Sonnet, HTTP fallback | Pass after fixes | Native fallback after controlled upgrade rejection; both unpredictable file values returned through tool/result follow-ups. |
| GPT-6 Astra → Opus | Pass | Native child read/tool-result/parent round trip. |
| GPT-6 Astra → Fable | Pass | Native child read/tool-result/parent round trip. |
| Claude Code → GPT-5.5 | Pass | Native Agent and Read calls, tool-result continuation, exact value returned. |
| Claude-backed native coding session | Pass | Inspected and patched `calculator.mjs`; independent execution confirmed `add(7, 5) === 12`. |
| GPT-6 Astra → Claude coding child | Pass | Child edited the file and ran commands; independently inspected and executed the resulting file. |
| Mixed native children | Pass | Two loaded child sessions, Sonnet and GPT-5.5 observed on actual gateway requests; four unpredictable values returned through separate follow-ups. |
| Both directions through one proxy concurrently | Pass | Mixed Codex children completed while native Claude Code performed a GPT-5.5 Read round trip through the same server; two forward translated requests completed. |
| Cancel then continue the same native conversation | Failed before fix; passes after | Turn reported interrupted, then the same thread completed a new request with the expected response. |
| Missing Claude credentials then restore | Pass after error fix | Native client shows Claude-specific sign-in/store guidance; restoring credentials allows the same conversation to proceed. |
| Controlled upstream 429 then recover | Pass | Native client surfaces 429 after its retry budget; fresh conversation succeeds once the injected fault is removed. |
| Restart proxy during a translated conversation | Expected limitation verified | Old state returns 409 with explicit new-conversation guidance; a fresh native conversation works. |
| Genuine Claude subscription refresh | Pass | One injected 401 → exactly one refresh → successful native tool/result continuation; rotated access/refresh tokens persisted, expiry valid, other credential fields preserved. |
| Interactive `init --client all` | Pass | Actual port prompt and writes; native comments/instructions, Claude permissions, and unrelated environment settings preserved. |
| Setup dry-run and repeat | Pass | Dry-run wrote no config; repeated setup with the same options was idempotent. |
| Fresh-shell serve/doctor | Pass | Proxy health available and `doctor --client all` exits 0. |
| User/project config precedence | Pass | Project alias overrides user default; another project sees the user default. |
| Custom upstream trust | Pass | Setup names the unapproved host and trust option, exits 1, and writes nothing. |
| `both` compatibility alias | Pass | Accepted by setup/model commands; model JSON matches canonical `all` output. |

## Usability defects corrected

1. Native cancellation retained an opaque replay handle whose state had never been
   committed. The next turn failed with `missing_claude_replay_state`. A bounded empty
   placeholder now allows the client's readable partial history to continue; opaque
   thinking/tool content is still committed only at a valid terminal event.
2. Codex adds an ordered `<turn_aborted>` developer notice after an interruption.
   That factual notice is retained at its original history position. Other unsupported
   mid-history instructions still fail explicitly.
3. Local Claude credential errors used 401, which made native Codex try to refresh its
   unrelated OpenAI login. They now use 503 with Claude-specific recovery guidance.
4. Lost-state errors now tell the user to start a new conversation.
5. `all` is the public client selector, backed by the supported-client registry;
   `both` remains a compatibility alias. Adding a client still requires its integration.

## Reproduce the existing live runners

```sh
npm run probe:native-production -- sonnet
npm run probe:native-production -- sonnet --http
npm run probe:native-production -- opus --no-followup
npm run probe:native-production -- fable --no-followup
npm run probe:native-claude -- --openai
```

Additional session scenarios used `thread/start`, `turn/start`, `turn/interrupt`,
and `turn/completed` against an isolated native app-server. Coding tests verified
filesystem changes independently. Mixed-child tests observed model names at the
production gateway's resolution boundary without changing its decisions. Model validation uses actual request metadata and loaded-child counts.

The local execution driver and redacted machine-readable evidence are archived under
`.devflow/docs/usability/feat-bidirectional-parity/2026-09-09/` (gitignored run artifacts).

## Scope and cleanup

Most runs used temporary profiles and access-only credential copies. The genuine
refresh test intentionally used the production Claude credential store and persisted
its rotated tokens; other store fields were preserved. Native settings were confined
to disposable profiles/projects, and each runner owned and cleaned up its processes.
No native binary, inherited hook, or real project setting was changed.

Native Codex retries some 429/503 failures before displaying the final error. Durable
resume across proxy restarts and general mid-history instruction changes remain outside
the current parity scope. These results do not claim a visual desktop-UI review.

The full regression suite passes 852 tests, including new cancellation-history and
credential-error controls. Typecheck, build, and installed-package smoke also pass.
