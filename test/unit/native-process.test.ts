import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { nativeProcess, isolatedNativeEnv } from "../../e2e/gates/native-process.js";
describe("isolated native process lifecycle", () => {
  const options = { cwd: tmpdir(), env: isolatedNativeEnv({}), timeoutMs: 3000 };

  it("closes stdin so a native CLI can start processing its argument prompt", async () => {
    const result = await nativeProcess(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end',()=>console.log('eof-observed'));"], options);
    assert.equal(result.code, 0);
    assert.equal(result.failure, undefined);
    assert.equal(result.stdout.trim(), "eof-observed");
  });

  it("does not mistake a graceful exit after the deadline for success", async () => {
    const result = await nativeProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);"], {
      ...options, timeoutMs: 200,
    });
    assert.equal(result.failure, "timeout");
  });

  it("terminates an output flood without keeping the oversized chunk", async () => {
    const result = await nativeProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000)); setInterval(()=>{},1000);"], {
      ...options, maxBytes: 100,
    });
    assert.equal(result.failure, "output_limit");
    assert.ok(result.stdout.length <= 100);
  });

  it("reports a missing client without exposing spawn exception details", async () => {
    const result = await nativeProcess("/nonexistent-subswitch-native-client", [], options);
    assert.equal(result.failure, "spawn_error");
    assert.equal(result.stderr, "");
  });

  it("starts with explicit test credentials and no inherited client configuration", () => {
    const env = isolatedNativeEnv({ CODEX_HOME: "/fabricated-home", OPENAI_API_KEY: "fabricated-key" });
    assert.equal(env["CODEX_HOME"], "/fabricated-home");
    assert.equal(env["OPENAI_API_KEY"], "fabricated-key");
    for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "SUBSWITCH_CONFIG", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS"])
      assert.equal(env[key], undefined);
  });
});
