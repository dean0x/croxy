import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCodexDoctor } from "../../src/codex-doctor.js";
import { loadConfig } from "../../src/config.js";

describe("Codex doctor", () => {
  it("checks routing, auth, native setup and configured agent model files without refreshing", async () => {
    const loaded = loadConfig({ configPath: "fixture", readFile: () => '{"providers":{"codex":{"authFile":"/fixture/native/auth.json"}},"codexIngress":{"enabled":true,"claude":{"enabled":true}}}' });
    assert.ok(loaded.ok);
    const output: string[] = [];
    const result = await runCodexDoctor(loaded.value.config, line => output.push(line), {
      env: { CODEX_HOME: "/fixture/native" }, project: "/fixture/project",
      read: async path => path === "/fixture/native/config.toml" ? 'openai_base_url = "http://127.0.0.1:4141/codex/backend-api/codex"\n[agents.worker]\nconfig_file = "worker.toml"' :
        path === "/fixture/native/worker.toml" ? 'model = "sonnet"' : path === "/fixture/native/auth.json" ?
          '{"tokens":{"access_token":"fixture-access","refresh_token":"fixture-refresh","account_id":"fixture-account"}}' : null,
      auth: async () => ({ available: true, expired: false, refreshable: true }),
      httpGet: async () => ({ ok: true, status: 200, body: '{"codexIngress":{"translationAvailable":true}}' }),
      tlsConnect: async () => ({ kind: "reachable" }),
    });
    assert.equal(result, 0); assert.match(output.join("\n"), /agent worker: sonnet → claude-sonnet-5/);
  });
  it("fails missing credentials, disabled routing, and unavailable native setup", async () => {
    const loaded = loadConfig({ configPath: "fixture", readFile: () => "{}" }); assert.ok(loaded.ok);
    const output: string[] = [];
    const result = await runCodexDoctor(loaded.value.config, line => output.push(line), {
      env: { CODEX_HOME: "/fixture/native" }, project: "/fixture/project", read: async () => null,
      auth: async () => ({ available: false, expired: false, refreshable: false }),
      httpGet: async () => ({ ok: false, connectionRefused: true }), tlsConnect: async () => ({ kind: "reachable" }),
    });
    assert.equal(result, 1); assert.match(output.join("\n"), /sign in with Claude Code/); assert.match(output.join("\n"), /start subswitch serve/);
  });
});
