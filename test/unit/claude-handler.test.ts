import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeHandler, ClaudeHttpError } from "../../src/claude-handler.js";
import type { ClaudeAuth } from "../../src/claude-auth.js";
import { loadConfig } from "../../src/config.js";
import { ok } from "../../src/result.js";

const config = () => {
  const loaded = loadConfig({ configPath: "/fixture.json", readFile: () => "{}", env: {} });
  assert.ok(loaded.ok); return loaded.value.config.codexIngress.claude;
};
const credential = (token: string) => ok({ provider: "claude" as const, authHeaders: { authorization: `Bearer ${token}` } });
const success = () => new Response([
  { type: "message_start", message: { type: "message" } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
const collect = async (handler: ClaudeHandler, signal = new AbortController().signal) => {
  const events = [];
  for await (const event of handler.respond({ model: "claude-sonnet-5", input: "hello" }, signal)) events.push(event);
  return events;
};

describe("Claude subscription request controls", () => {
  // MUTATION CHECK: disabling the 401 refresh branch must fail both retry assertions.
  it("refreshes a rejected token once and pins subscription identity independently", async () => {
    let refreshes = 0;
    const auth: ClaudeAuth = { getCredentials: async () => credential("old-token"), forceRefresh: async () => {
      refreshes++; return credential("new-token");
    } };
    const tokens: (string | null)[] = [];
    const handler = new ClaudeHandler(config(), auth, { log() {} }, async (_url, options) => {
      const headers = new Headers(options?.headers);
      tokens.push(headers.get("authorization"));
      assert.equal(headers.get("anthropic-beta"), "claude-code-20250219,oauth-2025-04-20");
      assert.equal(JSON.parse(String(options?.body)).system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
      return tokens.length === 1 ? new Response("unauthorized", { status: 401 }) : success();
    });
    assert.equal((await collect(handler)).at(-1)?.["type"], "response.completed");
    assert.deepEqual(tokens, ["Bearer old-token", "Bearer new-token"]);
    assert.equal(refreshes, 1);
  });

  it("stops after a second 401 without another refresh or fallback", async () => {
    let refreshes = 0, requests = 0;
    const handler = new ClaudeHandler(config(), {
      getCredentials: async () => credential("old-token"), forceRefresh: async () => { refreshes++; return credential("new-token"); },
    }, { log() {} }, async () => { requests++; return new Response("unauthorized", { status: 401 }); });
    await assert.rejects(collect(handler), error => error instanceof ClaudeHttpError && error.status === 401);
    assert.equal(requests, 2); assert.equal(refreshes, 1);
  });

  it("reports a request timeout as 504 and aborts the fetch", async () => {
    const handler = new ClaudeHandler({ ...config(), requestTimeoutMs: 25 }, {
      getCredentials: async () => credential("fixture"), forceRefresh: async () => assert.fail("unexpected refresh"),
    }, { log() {} }, async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    await assert.rejects(collect(handler), error => error instanceof ClaudeHttpError && error.status === 504 && error.code === "claude_timeout");
  });

  it("aborts a stalled stream with 504 and cancels its reader", async () => {
    let cancelled = false;
    const handler = new ClaudeHandler({ ...config(), streamIdleTimeoutMs: 25 }, {
      getCredentials: async () => credential("fixture"), forceRefresh: async () => assert.fail("unexpected refresh"),
    }, { log() {} }, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"type":"message"}}\n\n')); },
      cancel() { cancelled = true; },
    })));
    await assert.rejects(collect(handler), error => error instanceof ClaudeHttpError && error.status === 504);
    assert.equal(cancelled, true);
  });
});
