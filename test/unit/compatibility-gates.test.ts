import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collaborationTools, TASK, PLAINTEXT_ARGUMENTS } from "../../e2e/gates/contracts.js";
import { CredentialUnavailable, probeHeaders, type CredentialDeps } from "../../e2e/gates/credentials.js";
import { runProbe, reportExitCode, type ProbeOptions } from "../../e2e/gates/probe.js";
import { parseArgs } from "../../e2e/gates/run.js";

const completed = (output: unknown[] = []) => new Response(`data: ${JSON.stringify({
  type: "response.completed", response: { id: "resp_gate", status: "completed", output },
})}\n\n`, { headers: { "content-type": "text/event-stream" } });
const toolCall = () => completed([{
  type: "function_call", name: "spawn_agent", namespace: "collaboration",
  arguments: JSON.stringify({ task_name: "probe", message: TASK }),
}]);

function fakeFetch(responses: Response[]) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.ok(init);
    requests.push({ url: String(input), init, body: JSON.parse(String(init.body)) });
    const response = responses.shift();
    assert.ok(response, "Unexpected retry or continuation after a failed gate");
    return response;
  };
  return { fetchImpl, requests };
}
const base: ProbeOptions = { provider: "openai", auth: "subscription", model: "fixture-model", headers: {} };

describe("bidirectional compatibility gates", () => {
  it("changes exactly the three native message encryption annotations", () => {
    const before = collaborationTools(false);
    const after = collaborationTools();
    let changes = 0;
    for (const tool of after.tools) {
      const message = tool.parameters.properties["message"];
      if (["spawn_agent", "send_message", "followup_task"].includes(tool.name)) {
        assert.equal(message?.encrypted, false);
        message!.encrypted = true;
        changes++;
      }
    }
    assert.equal(changes, 3);
    assert.deepEqual(after, before);
    assert.deepEqual(collaborationTools(false), before, "fixture must not be mutated between requests");
  });

  it("runs a native control before diagnosing modified schemas and stops on rejection", async () => {
    const fake = fakeFetch([completed(), Response.json({ error: {
      type: "invalid_request_error", param: "tools",
      message: "Invalid Value: 'tools'. Function 'collaboration.followup_task' is reserved for use by this model and must match the configured schema.",
    } }, { status: 400 })]);
    const report = await runProbe({ ...base, fetchImpl: fake.fetchImpl });
    assert.equal(reportExitCode(report), 1);
    assert.deepEqual(report.results.map((r) => [r.status, r.code]), [
      ["pass", "accepted"], ["fail", "reserved_collaboration_schema_followup_task"],
    ]);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(fake.requests[0]?.init.redirect, "error");
    const control = fake.requests[0]!.body;
    const modified = structuredClone(fake.requests[1]!.body);
    const input = modified["input"] as Record<string, unknown>[];
    // The namespace-only test above proves exactly which booleans changed. This
    // assertion also prevents changing the input/model/other request fields.
    input[0]!["tools"] = [collaborationTools(false)];
    assert.deepEqual(modified, control);
  });

  it("does not label ciphertext or malformed JSON as plaintext", async () => {
    for (const args of ["ciphertext", '{"message":', JSON.stringify({ message: "encrypted-value", task_name: "probe" })]) {
      const fake = fakeFetch([completed(), completed(), completed([{
        type: "function_call", namespace: "collaboration", name: "spawn_agent", arguments: args,
      }])]);
      const report = await runProbe({ ...base, fetchImpl: fake.fetchImpl });
      assert.equal(report.results.at(-1)?.code, "plaintext_arguments_not_observed");
      assert.equal(fake.requests.length, 3);
    }
  });

  it("tests native markers only after observing the expected readable arguments", async () => {
    const fake = fakeFetch([completed(), completed(), toolCall(), completed()]);
    const report = await runProbe({ ...base, auth: "api", fetchImpl: fake.fetchImpl });
    assert.equal(reportExitCode(report), 0);
    assert.equal(fake.requests.length, 4);
    assert.ok(fake.requests.every((r) => r.url === "https://api.openai.com/v1/responses"));
    const input = fake.requests[3]?.body["input"] as Record<string, unknown>[];
    assert.deepEqual(input.find((i) => i["type"] === "function_call")?.["encrypted_function_args"], PLAINTEXT_ARGUMENTS);
    assert.deepEqual(input.find((i) => i["type"] === "agent_message")?.["content"], [{ type: "input_text", text: "gate-ok" }]);
  });

  it("tests plaintext history independently without modifying the reserved native schemas", async () => {
    const fake = fakeFetch([completed(), completed()]);
    const report = await runProbe({ ...base, contract: "native-history", fetchImpl: fake.fetchImpl });
    assert.equal(reportExitCode(report), 0);
    assert.equal(report.results.at(-1)?.gate, "openai_native_plaintext_history");
    const input = fake.requests[1]?.body["input"] as Record<string, unknown>[];
    assert.deepEqual(input[0]?.["tools"], [collaborationTools(false)]);
    assert.deepEqual(input.find((i) => i["type"] === "function_call")?.["encrypted_function_args"], []);
    const message = input.find((i) => i["type"] === "agent_message");
    assert.ok(String(message?.["id"]).startsWith("amsg"));
    assert.deepEqual(message?.["content"], [{ type: "input_text", text: "gate-ok" }]);
    assert.throws(() => parseArgs(["--provider", "claude", "--model", "fixture", "--contract", "native-history"]));
  });

  it("isolates each reserved encryption annotation and stops a matrix on availability failures", async () => {
    const names = ["spawn_agent", "send_message", "followup_task"];
    const rejected = names.flatMap((name) => ["false", "omit"].map(() => Response.json({ error: {
      type: "invalid_request_error", param: "tools",
      message: `Invalid Value: 'tools'. Function 'collaboration.${name}' is reserved for use by this model and must match the configured schema.`,
    } }, { status: 400 })));
    const fake = fakeFetch([completed(), ...rejected]);
    const report = await runProbe({ ...base, contract: "schema-fields", fetchImpl: fake.fetchImpl });
    assert.equal(fake.requests.length, 7);
    assert.equal(reportExitCode(report), 1);
    for (const [index, name] of names.entries()) for (const [variant, mode] of ["false", "omit"].entries()) {
      const requestIndex = 1 + index * 2 + variant;
      const body = structuredClone(fake.requests[requestIndex]!.body);
      const input = body["input"] as { tools: ReturnType<typeof collaborationTools>[] }[];
      const message = input[0]!.tools[0]!.tools.find((tool) => tool.name === name)!.parameters.properties["message"]!;
      assert.equal(message.encrypted, mode === "false" ? false : undefined);
      message.encrypted = true;
      assert.deepEqual(body, fake.requests[0]!.body, "only one annotation may differ from the control");
      assert.equal(report.results[requestIndex]?.code, `reserved_collaboration_schema_${name}`);
    }
    const unavailable = fakeFetch([completed(), Response.json({ error: { type: "rate_limit_error" } }, { status: 429 })]);
    const stopped = await runProbe({ ...base, contract: "schema-fields", fetchImpl: unavailable.fetchImpl });
    assert.equal(unavailable.requests.length, 2);
    assert.equal(reportExitCode(stopped), 2);
  });

  it("distinguishes ordinary namespace acceptance from native reserved-schema acceptance", async () => {
    for (const message of [TASK, "fabricated-opaque-task"]) {
      const fake = fakeFetch([completed(), completed(), completed([{
        type: "function_call", namespace: "subswitch_collaboration", name: "spawn_agent",
        arguments: JSON.stringify({ task_name: "probe", model: "claude-sonnet-5", message }),
      }]), ...(message === TASK ? [completed()] : [])]);
      const report = await runProbe({ ...base, contract: "namespace-control", fetchImpl: fake.fetchImpl });
      assert.equal(reportExitCode(report), message === TASK ? 0 : 1);
      assert.equal(fake.requests.length, message === TASK ? 4 : 3);
      const renamed = structuredClone(fake.requests[1]!.body);
      const input = renamed["input"] as { tools: ReturnType<typeof collaborationTools>[] }[];
      const namespace = input[0]!.tools[0]!;
      assert.equal(namespace.name, "subswitch_collaboration");
      namespace.name = "collaboration";
      for (const tool of namespace.tools) if (["spawn_agent", "send_message", "followup_task"].includes(tool.name)) {
        assert.equal(tool.parameters.properties["message"]?.encrypted, false);
        tool.parameters.properties["message"]!.encrypted = true;
      }
      assert.deepEqual(renamed, fake.requests[0]!.body);
      assert.deepEqual(collaborationTools(false).name, "collaboration");
      assert.ok(!JSON.stringify(report).includes("fabricated-opaque-task"));
    }
  });

  it("checks generated Sonnet task readability without schema rewriting or executing an agent", async () => {
    for (const message of [TASK, "fabricated-opaque-task"]) {
      const fake = fakeFetch([completed(), completed([{
        type: "function_call", name: "spawn_agent", namespace: "collaboration",
        arguments: JSON.stringify({ model: "claude-sonnet-5", task_name: "probe", message }),
      }])]);
      const report = await runProbe({ ...base, contract: "native-arguments", fetchImpl: fake.fetchImpl });
      assert.equal(reportExitCode(report), message === TASK ? 0 : 1);
      assert.equal(fake.requests.length, 2);
      const input = fake.requests[1]?.body["input"] as Record<string, unknown>[];
      assert.deepEqual(input[0]?.["tools"], [collaborationTools(false)]);
      assert.ok(!JSON.stringify(report).includes("fabricated-opaque-task"));
    }
  });

  it("uses completed output items when Responses-lite omits terminal output", async () => {
    const tool = { type: "function_call", name: "spawn_agent", namespace: "collaboration",
      arguments: JSON.stringify({ task_name: "probe", message: TASK }), encrypted_function_args: [] };
    const stream = new Response(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: tool })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
    const fake = fakeFetch([completed(), completed(), stream, completed()]);
    const report = await runProbe({ ...base, fetchImpl: fake.fetchImpl });
    assert.equal(reportExitCode(report), 0);
    assert.equal(fake.requests.length, 4);
  });

  it("rejects missing or duplicated output indices even when a terminal event arrives", async () => {
    for (const indices of [[1], [0, 0]]) {
      const stream = new Response(indices.map((output_index) => `data: ${JSON.stringify({
        type: "response.output_item.done", output_index, item: { type: "message", content: [] },
      })}\n\n`).join("") + `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
      const fake = fakeFetch([stream]);
      const report = await runProbe({ ...base, fetchImpl: fake.fetchImpl });
      assert.equal(reportExitCode(report), 1);
      assert.equal(fake.requests.length, 1);
    }
  });

  it("keeps upstream/auth failures blocked with retry guidance and makes no fallback requests", async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const fake = fakeFetch([Response.json({ error: { type: "rate_limit_error", message: "secret upstream text" } }, {
        status, headers: { "retry-after": "120", "set-cookie": "secret=credential" },
      })]);
      const report = await runProbe({ ...base, provider: "claude", fetchImpl: fake.fetchImpl });
      assert.equal(reportExitCode(report), 2);
      assert.deepEqual(report.results, [{
        gate: "claude_tool_call", status: "blocked", code: "rate_limit_error", httpStatus: status, retryAfter: "120",
      }]);
      assert.equal(fake.requests.length, 1);
      assert.ok(!JSON.stringify(report).includes("secret"));
    }
  });

  it("distinguishes an explicit Claude spend limit from an unexplained 429 without leaking details", async () => {
    for (const [errorCode, expected] of [
      [undefined, "rate_limit_error"],
      ["private-unknown-code", "rate_limit_error"],
      ["enforced_spend_limit_reached", "enforced_spend_limit_reached"],
    ]) {
      const fake = fakeFetch([Response.json({ error: {
        type: "rate_limit_error", message: "Error",
        details: { error_code: errorCode, private_context: "secret" },
      } }, { status: 429 })]);
      const report = await runProbe({ ...base, provider: "claude", fetchImpl: fake.fetchImpl });
      assert.deepEqual(report.results, [{
        gate: "claude_tool_call", status: "blocked", code: expected, httpStatus: 429,
      }]);
      assert.equal(fake.requests.length, 1);
      assert.ok(!JSON.stringify(report).includes("secret"));
      assert.ok(!JSON.stringify(report).includes("private-unknown-code"));
    }
  });

  it("redacts unknown error codes, raw errors, headers, and invalid Retry-After", async () => {
    const fake = fakeFetch([Response.json({ error: { type: "secret", message: "secret" } }, {
      status: 400, headers: { "retry-after": "secret" },
    })]);
    const report = await runProbe({ ...base, fetchImpl: fake.fetchImpl });
    assert.equal(report.results[0]?.code, "upstream_http_error");
    assert.ok(!JSON.stringify(report).includes("secret"));
  });

  it("requires a completed stream with a valid terminal status", async () => {
    for (const frame of [
      'data: [DONE]\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"message"}}\n\n',
      'data: {"type":"response.failed"}\n\n',
      'data: {"type":"response.completed","response":{"status":"incomplete","output":[]}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: {"type":"response.failed"}\n\n',
      'data: {broken}\n\n',
    ]) {
      const fake = fakeFetch([new Response(frame)]);
      assert.equal(reportExitCode(await runProbe({ ...base, fetchImpl: fake.fetchImpl })), 1);
      assert.equal(fake.requests.length, 1);
    }
  });

  it("preserves Claude assistant state verbatim across a real-shaped tool continuation", async () => {
    const content = [
      { type: "thinking", thinking: "fabricated private reasoning", signature: "fabricated-signature" },
      { type: "redacted_thinking", data: "fabricated-opaque-state" },
      { type: "tool_use", id: "toolu_gate", name: "echo", input: { text: "gate-ok" } },
    ];
    const fake = fakeFetch([
      Response.json({ type: "message", stop_reason: "tool_use", content }),
      Response.json({ type: "message", stop_reason: "end_turn", content: [{ type: "text", text: "gate-ok" }] }),
    ]);
    const report = await runProbe({ ...base, provider: "claude", fetchImpl: fake.fetchImpl });
    assert.equal(reportExitCode(report), 0);
    const messages = fake.requests[1]?.body["messages"] as Record<string, unknown>[];
    assert.deepEqual(messages[1]?.["content"], content);
    assert.deepEqual(messages[2]?.["content"], [{ type: "tool_result", tool_use_id: "toolu_gate", content: "gate-ok" }]);
    assert.ok(!JSON.stringify(report).includes("fabricated"));
  });

  it("rejects truncated Claude tool output and incomplete continuations", async () => {
    const fake = fakeFetch([Response.json({ stop_reason: "max_tokens", content: [
      { type: "tool_use", id: "toolu_gate", name: "echo", input: { text: "gate-ok" } },
    ] })]);
    const report = await runProbe({ ...base, provider: "claude", fetchImpl: fake.fetchImpl });
    assert.equal(report.results[0]?.code, "unexpected_tool_call");
    assert.equal(fake.requests.length, 1);
    const continuation = fakeFetch([
      Response.json({ stop_reason: "tool_use", content: [
        { type: "tool_use", id: "toolu_gate", name: "echo", input: { text: "gate-ok" } },
      ] }),
      Response.json({ stop_reason: "max_tokens", content: [{ type: "text", text: "gate-ok" }] }),
    ]);
    const second = await runProbe({ ...base, provider: "claude", fetchImpl: continuation.fetchImpl });
    assert.equal(second.results[1]?.code, "invalid_continuation");
  });

  it("cancels an oversized response and never reports it as successful", async () => {
    let cancelled = false;
    const fake = fakeFetch([new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }))]);
    const report = await runProbe({ ...base, fetchImpl: fake.fetchImpl });
    assert.equal(report.results[0]?.code, "response_too_large");
    assert.equal(cancelled, true);
  });

  it("bounds hanging response bodies and redacts network exception messages", async () => {
    const fake = fakeFetch([new Response(new ReadableStream())]);
    const report = await runProbe({ ...base, timeoutMs: 10, fetchImpl: fake.fetchImpl });
    assert.equal(report.results[0]?.code, "request_timeout");
    const network = await runProbe({ ...base, fetchImpl: async () => { throw new Error("secret credential"); } });
    assert.equal(network.results[0]?.code, "network_error");
    assert.equal(reportExitCode(network), 2);
    assert.ok(!JSON.stringify(network).includes("secret"));
  });
});

describe("gate credential isolation and CLI", () => {
  function deps(overrides: Partial<CredentialDeps> = {}): CredentialDeps {
    return {
      env: { OPENAI_API_KEY: "openai-api-secret", ANTHROPIC_API_KEY: "claude-api-secret" },
      home: "/test-home", platform: "linux", now: () => 1000,
      read: async () => { throw new Error("Must not read a store for API authentication"); },
      keychain: async () => { throw new Error("Must not read Keychain for API authentication"); },
      ...overrides,
    };
  }

  it("uses only the selected provider's explicitly chosen API environment variable", async () => {
    const openai = await probeHeaders({ provider: "openai", auth: "api" }, deps());
    assert.equal(openai["authorization"], "Bearer openai-api-secret");
    assert.equal(openai["chatgpt-account-id"], undefined);
    assert.equal(openai["openai-beta"], undefined);
    assert.ok(!JSON.stringify(openai).includes("claude-api-secret"));
    const claude = await probeHeaders({ provider: "claude", auth: "api" }, deps());
    assert.equal(claude["x-api-key"], "claude-api-secret");
    assert.equal(claude["authorization"], undefined);
    assert.equal(claude["anthropic-beta"], undefined);
    assert.ok(!JSON.stringify(claude).includes("openai-api-secret"));
    const named = await probeHeaders({ provider: "claude", auth: "api", envName: "MY_KEY" }, deps({ env: { MY_KEY: "named-secret" } }));
    assert.equal(named["x-api-key"], "named-secret");
  });

  it("does not fall back from a missing API environment variable to subscription", async () => {
    await assert.rejects(probeHeaders({ provider: "openai", auth: "api" }, deps({ env: {} })),
      (e: unknown) => e instanceof CredentialUnavailable && e.code === "api_key_env_missing");
  });

  it("respects CODEX_HOME and keeps the subscription account header provider-specific", async () => {
    const headers = await probeHeaders({ provider: "openai", auth: "subscription" }, deps({
      env: { CODEX_HOME: "/isolated/codex" },
      read: async (path) => {
        assert.equal(path, "/isolated/codex/auth.json");
        return JSON.stringify({ tokens: { access_token: "codex-oauth", account_id: "account-fixture" } });
      },
    }));
    assert.equal(headers["authorization"], "Bearer codex-oauth");
    assert.equal(headers["chatgpt-account-id"], "account-fixture");
    assert.equal(headers["x-api-key"], undefined);
  });

  it("reads the selected Claude file store without copying or refreshing credentials", async () => {
    const headers = await probeHeaders({ provider: "claude", auth: "subscription" }, deps({
      env: { CLAUDE_CONFIG_DIR: "/isolated/claude", ANTHROPIC_API_KEY: "must-not-use" },
      read: async (path) => {
        assert.equal(path, "/isolated/claude/.credentials.json");
        return JSON.stringify({ claudeAiOauth: { accessToken: "claude-oauth", expiresAt: 2000 } });
      },
    }));
    assert.equal(headers["authorization"], "Bearer claude-oauth");
    assert.equal(headers["x-api-key"], undefined);
    assert.equal(headers["chatgpt-account-id"], undefined);
  });

  it("surfaces locked Keychain errors without trying other credentials", async () => {
    await assert.rejects(probeHeaders({ provider: "claude", auth: "subscription" }, deps({
      platform: "darwin", keychain: async (service) => {
        assert.equal(service, "Claude Code-credentials");
        throw new Error("Keychain secret internals");
      },
    })), (e: unknown) => e instanceof CredentialUnavailable && e.code === "claude_keychain_unavailable");
  });

  it("requires the native client to refresh expired tokens; never uses an available API key", async () => {
    const token = `eyJ.${Buffer.from(JSON.stringify({ exp: 0 })).toString("base64url")}.sig`;
    await assert.rejects(probeHeaders({ provider: "openai", auth: "subscription" }, deps({
      read: async () => JSON.stringify({ tokens: { access_token: token, account_id: "fixture" } }),
    })), (e: unknown) => e instanceof CredentialUnavailable && e.code === "codex_subscription_expired");
    await assert.rejects(probeHeaders({ provider: "claude", auth: "subscription" }, deps({
      read: async () => JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: 999 } }),
    })), (e: unknown) => e instanceof CredentialUnavailable && e.code === "claude_subscription_expired");
  });

  it("defaults to subscription and rejects literal keys, ambiguous flags, and absent models", () => {
    assert.deepEqual(parseArgs(["--provider", "claude", "--model", "claude-sonnet-5"]), {
      provider: "claude", auth: "subscription", model: "claude-sonnet-5",
    });
    for (const args of [[], ["--provider", "claude"],
      ["--provider", "claude", "--model", "fixture", "--key-env", "ANTHROPIC_API_KEY"],
      ["--provider", "claude", "--model", "fixture", "--auth", "api", "--key-env", "sk-literal-key"],
      ["--provider", "claude", "--model", "fixture", "--auth", "api", "--auth", "subscription"],
    ]) assert.throws(() => parseArgs(args));
  });
});
