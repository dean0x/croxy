import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createClaudeCredentialStore, type ClaudeStoreDeps } from "../../src/claude-auth.js";

describe("native Claude credential persistence", () => {
  it("atomically replaces a credential file with private permissions and no temporary residue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subswitch-store-"));
    try {
      const path = join(directory, "credentials.json");
      await writeFile(path, '{"old":true}', { mode: 0o644 });
      const store = createClaudeCredentialStore({ authFile: path });
      assert.equal(await store.read(), '{"old":true}');
      await store.write('{"new":"private fixture"}');
      assert.equal(await store.read(), '{"new":"private fixture"}');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(directory), ["credentials.json"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  const keychain = (account: string, persist = true) => {
    let stored = '{"old":true}', commands = "", spawned = 0;
    const deps: ClaudeStoreDeps = {
      platform: "darwin", env: {},
      exec: async (file, args) => {
        assert.equal(file, "security");
        return { stdout: args.includes("-w") ? Buffer.from(stored).toString("hex") : `"acct"<blob>=${JSON.stringify(account)}`, stderr: "" };
      },
      spawn: (file, args) => {
        assert.equal(file, "security"); assert.deepEqual(args, ["-i"]); spawned++;
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
        child.stdin.on("data", chunk => { commands += chunk.toString(); });
        child.stdin.on("finish", () => {
          if (persist) stored = Buffer.from(commands.trim().split(" -X ")[1]!, "hex").toString("utf8");
          child.emit("close", 0);
        });
        return child;
      },
    };
    return { store: createClaudeCredentialStore({}, deps), commands: () => commands, spawned: () => spawned };
  };

  it("sends keychain secrets through hex stdin and verifies the stored value", async () => {
    const fixture = keychain("fixture-account");
    assert.equal(await fixture.store.read(), '{"old":true}');
    await fixture.store.write('{"token":"private-fixture-😀"}');
    assert.equal(await fixture.store.read(), '{"token":"private-fixture-😀"}');
    assert.ok(!fixture.commands().includes("private-fixture"));
    assert.match(fixture.commands(), /^add-generic-password -U -s "Claude Code-credentials" -a "fixture-account" -X [a-f0-9]+\n$/);
  });

  it("rejects interactive-parser injection before spawning security", async () => {
    for (const account of ['bad"account', "bad\\account", "bad\naccount"]) {
      const fixture = keychain(account);
      await assert.rejects(fixture.store.write("fixture"), /keychain_account_unavailable/);
      assert.equal(fixture.spawned(), 0);
    }
  });

  it("rejects exit-zero keychain failures when read-back does not match", async () => {
    const fixture = keychain("fixture-account", false);
    await assert.rejects(fixture.store.write('{"new":true}'), /keychain_write_failed/);
    assert.equal(fixture.spawned(), 1);
  });
});
