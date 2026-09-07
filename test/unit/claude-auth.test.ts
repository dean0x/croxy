import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAuthManager, claudeCredentialLocation, type ClaudeCredentialStore } from "../../src/claude-auth.js";

const logger = { log() {} };
const record = (expiresAt: number, accessToken = "fixture-access", refreshToken = "fixture-refresh") => JSON.stringify({
  unrelated: { keep: true }, claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ["user:inference"], extra: "preserve" },
});
describe("Claude subscription credentials", () => {
  it("respects explicit files and native configuration-directory stores", () => {
    assert.equal(claudeCredentialLocation({ authFile: "/tmp/fixture.json" }, {}, "darwin").kind, "file");
    assert.deepEqual(claudeCredentialLocation({}, {}, "darwin"), { kind: "keychain", service: "Claude Code-credentials" });
    assert.notDeepEqual(claudeCredentialLocation({ configDir: "/tmp/other" }, {}, "darwin"), claudeCredentialLocation({}, {}, "darwin"));
    assert.deepEqual(claudeCredentialLocation({ configDir: "/tmp/config" }, {}, "linux"), { kind: "file", path: "/tmp/config/.credentials.json" });
  });
  it("uses valid native credentials without refreshing or switching authentication modes", async () => {
    let requests = 0;
    const auth = new ClaudeAuthManager({ store: { read: async () => record(9999999), write: async () => assert.fail("unexpected write") },
      oauthTokenUrl: "http://localhost/token", logger, now: () => 1000, fetchImpl: async () => { requests++; throw new Error(); } });
    assert.deepEqual(await auth.getCredentials(), { ok: true, value: { provider: "claude", authHeaders: { authorization: "Bearer fixture-access" } } });
    assert.equal(requests, 0);
  });
  it("single-flights refresh and preserves unknown credential fields", async () => {
    let raw = record(0), requests = 0, writes = 0;
    const store: ClaudeCredentialStore = { read: async () => raw, write: async value => { writes++; raw = value; } };
    const auth = new ClaudeAuthManager({ store, oauthTokenUrl: "http://localhost/token", logger, now: () => 1000,
      fetchImpl: async () => { requests++; await new Promise(resolve => setTimeout(resolve, 10)); return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })); } });
    const results = await Promise.all(Array.from({ length: 12 }, () => auth.getCredentials()));
    assert.ok(results.every(result => result.ok)); assert.equal(requests, 1); assert.equal(writes, 1);
    const saved = JSON.parse(raw); assert.deepEqual(saved.unrelated, { keep: true }); assert.equal(saved.claudeAiOauth.extra, "preserve");
    assert.equal(saved.claudeAiOauth.refreshToken, "new-refresh");
  });
  it("adopts external rotation after rejection without overwriting native credentials", async () => {
    let raw = record(0), writes = 0;
    const auth = new ClaudeAuthManager({ store: { read: async () => raw, write: async () => { writes++; } }, oauthTokenUrl: "http://localhost/token", logger, now: () => 1000,
      fetchImpl: async () => { raw = record(9999999, "native-rotated", "native-refresh"); return new Response('{"error":"invalid_grant"}', { status: 400 }); } });
    const result = await auth.getCredentials(); assert.ok(result.ok);
    assert.equal(result.value.authHeaders["authorization"], "Bearer native-rotated"); assert.equal(writes, 0);
  });
  it("fails credential persistence without exposing the refreshed secret", async () => {
    const auth = new ClaudeAuthManager({ store: { read: async () => record(0), write: async () => { throw new Error("fixture-secret"); } },
      oauthTokenUrl: "http://localhost/token", logger, now: () => 1000,
      fetchImpl: async () => new Response('{"access_token":"fixture-secret","refresh_token":"new-refresh","expires_in":3600}') });
    const result = await auth.getCredentials(); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  });
  it("adopts a native refresh between inference and the forced-refresh request", async () => {
    let raw = record(9999999), requests = 0;
    const auth = new ClaudeAuthManager({ store: { read: async () => raw, write: async () => assert.fail("unexpected write") },
      oauthTokenUrl: "http://localhost/token", logger, now: () => 1000, fetchImpl: async () => { requests++; throw new Error(); } });
    assert.ok((await auth.getCredentials()).ok);
    raw = record(9999999, "native-new", "native-refresh-new");
    const refreshed = await auth.forceRefresh(); assert.ok(refreshed.ok);
    assert.equal(refreshed.value.authHeaders["authorization"], "Bearer native-new"); assert.equal(requests, 0);
  });
});
