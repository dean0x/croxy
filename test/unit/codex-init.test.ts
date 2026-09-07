import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planCodexEndpoint, planNativeSetup } from "../../src/codex-init.js";
import { loadConfig, mergeConfigObjects } from "../../src/config.js";
import type { InitFsDeps } from "../../src/init.js";
import { resolve } from "node:path";

describe("Codex setup parity", () => {
  it("changes only the root endpoint value, preserving native settings and comments", () => {
    const original = '# comment\nmodel = "gpt-6-astra"\n"openai_base_url" = \'https://chatgpt.com/backend-api/codex\' # preserve\n[agents.worker]\nmodel = "sonnet"\n';
    const result = planCodexEndpoint(original, 4141);
    assert.equal(result.content, original.replace("'https://chatgpt.com/backend-api/codex'", '"http://127.0.0.1:4141/codex/backend-api/codex"'));
    assert.equal(planCodexEndpoint(result.content, 4141).content, result.content);
  });
  it("does not confuse multiline string content or nested keys with root settings", () => {
    const original = 'developer_instructions = """\nopenai_base_url = \'example\'\n[not_a_table]\n"""\n[model_providers.example]\nopenai_base_url = "nested"\n';
    const result = planCodexEndpoint(original, 4142);
    assert.equal(result.content, 'openai_base_url = "http://127.0.0.1:4142/codex/backend-api/codex"\n' + original);
    assert.throws(() => planCodexEndpoint('model_provider = "custom"\n', 4141), /custom model_provider/);
    assert.throws(() => planCodexEndpoint('openai_base_url = "unfinished', 4141), /Cannot parse Codex/);
  });
  it("plans all writes first and preserves a previously selected upstream", async () => {
    const files = new Map([
      ["/native/config.toml", 'openai_base_url = "https://trusted.example/v1"\nmodel = "gpt-6-astra"\n'],
      ["/global/config.json", '{"codexIngress":{"claude":{"aliases":{"worker":"claude-sonnet-5"}}}}'],
    ]);
    const fs: InitFsDeps = { readFile: async path => files.get(path) ?? null, exists: path => files.has(path), writeFile: async () => assert.fail("planning wrote files") };
    const plans = await planNativeSetup({ client: "codex", port: 4141, settingsTarget: "local" },
      { codexConfig: "/native/config.toml", subswitchConfig: "/global/config.json", project: "/project" }, fs);
    assert.equal(plans.length, 2);
    const global = JSON.parse(plans[0]!.content);
    assert.equal(global.codexIngress.subscriptionBaseUrl, "https://trusted.example/v1");
    assert.equal(global.codexIngress.allowCustomUpstream, true); assert.equal(global.codexIngress.claude.enabled, true);
    assert.deepEqual(global.codexIngress.claude.aliases, { worker: "claude-sonnet-5" });
    assert.ok(!plans[1]!.preview.includes('model ='));
  });
  it("does not overwrite reverse configuration when both clients use the same config file", async () => {
    const fs: InitFsDeps = { readFile: async () => null, exists: () => false, writeFile: async () => assert.fail() };
    const plans = await planNativeSetup({ client: "both", port: 4141, settingsTarget: "local" },
      { codexConfig: "/native/config.toml", subswitchConfig: "/project/subswitch.config.json", project: "/project" }, fs);
    assert.equal(plans.filter(plan => plan.path === "/project/subswitch.config.json").length, 1);
    assert.equal(JSON.parse(plans[0]!.content).codexIngress.claude.enabled, true);
    assert.equal(plans.at(-1)?.path, "/project/.claude/settings.local.json");
  });
  it("deduplicates relative and absolute references to the same configuration", async () => {
    const fs: InitFsDeps = { readFile: async path => path === "/native/config.toml" ? 'openai_base_url = "https://trusted.example/v1"' : null,
      exists: () => false, writeFile: async () => assert.fail() };
    const plans = await planNativeSetup({ client: "both", port: 4141, settingsTarget: "local" },
      { codexConfig: "/native/config.toml", subswitchConfig: "./subswitch.config.json", project: process.cwd() }, fs);
    const configWrites = plans.filter(plan => resolve(plan.path) === resolve("subswitch.config.json"));
    assert.equal(configWrites.length, 1);
    assert.equal(JSON.parse(configWrites[0]!.content).codexIngress.subscriptionBaseUrl, "https://trusted.example/v1");
  });
});

describe("user configuration fallback", () => {
  it("merges project settings over user defaults without losing sibling fields", () => {
    const result = loadConfig({ env: {}, globalConfigPath: "/fixture/global.json", readFile: path => path === "/fixture/global.json" ?
      '{"port":4142,"codexIngress":{"enabled":true,"claude":{"enabled":true,"aliases":{"worker":"claude-sonnet-5"}}}}' :
      '{"codexIngress":{"claude":{"aliases":{"second":"claude-opus-5"}}}}' });
    assert.ok(result.ok); assert.equal(result.value.config.port, 4142); assert.equal(result.value.config.codexIngress.claude.enabled, true);
    assert.deepEqual(result.value.config.codexIngress.claude.aliases, { worker: "claude-sonnet-5", second: "claude-opus-5" });
  });
  it("keeps explicit configuration authoritative and preserves own-property semantics", () => {
    const reads: string[] = [];
    const result = loadConfig({ configPath: "/explicit.json", globalConfigPath: "/ignored.json", env: {}, readFile: path => { reads.push(path); return "{}"; } });
    assert.ok(result.ok); assert.deepEqual(reads, ["/explicit.json"]);
    const merged = mergeConfigObjects({}, JSON.parse('{"__proto__":{"injected":true}}'));
    assert.equal(Object.prototype.hasOwnProperty.call(merged, "__proto__"), true);
    assert.equal(({} as Record<string, unknown>)["injected"], undefined);
  });
});
