import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { object } from "./claude-contract.js";
import { expandHome, type ClaudeProviderConfig } from "./config.js";
import { ok, err, type Result } from "./result.js";
import type { ProxyError } from "./errors.js";
import type { Logger } from "./logger.js";
import { readBoundedText } from "./provider-transport.js";

const exec = promisify(execFile);
const authError = (message: string): ProxyError => ({ kind: "auth", message });
export interface ClaudeCredential { readonly provider: "claude"; readonly authHeaders: Readonly<Record<string, string>> }
export interface ClaudeCredentialStore {
  read(): Promise<string>;
  write(raw: string): Promise<void>;
}
export interface ClaudeAuth {
  getCredentials(): Promise<Result<ClaudeCredential, ProxyError>>;
  forceRefresh(): Promise<Result<ClaudeCredential, ProxyError>>;
}

export function claudeCredentialLocation(config: Pick<ClaudeProviderConfig, "authFile" | "configDir">, env = process.env, platform = process.platform) {
  if (config.authFile) return { kind: "file" as const, path: expandHome(config.authFile) };
  const configured = config.configDir ?? env["CLAUDE_CONFIG_DIR"];
  const directory = configured === undefined ? join(homedir(), ".claude") : expandHome(configured);
  if (platform !== "darwin") return { kind: "file" as const, path: join(directory, ".credentials.json") };
  const service = "Claude Code-credentials" + (configured === undefined ? "" : `-${createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 8)}`);
  return { kind: "keychain" as const, service };
}

export function createClaudeCredentialStore(config: Pick<ClaudeProviderConfig, "authFile" | "configDir">): ClaudeCredentialStore {
  const location = claudeCredentialLocation(config);
  if (location.kind === "file") return {
    read: () => readFile(location.path, "utf8"),
    async write(raw) {
      const temporary = `${location.path}.subswitch-${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, location.path);
      } finally { await unlink(temporary).catch(() => undefined); }
    },
  };
  const read = async () => {
    const output = (await exec("security", ["find-generic-password", "-s", location.service, "-w"], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trimEnd();
    // security emits non-ASCII password data as bare hex. Native credential data is JSON.
    return /^7b(?:[0-9a-f]{2})+$/i.test(output) ? Buffer.from(output, "hex").toString("utf8") : output;
  };
  return {
    read,
    async write(raw) {
      const metadata = await exec("security", ["find-generic-password", "-s", location.service], { timeout: 10000, maxBuffer: 1024 * 1024 });
      const account = /"acct"<blob>=(?:("(?:[^"\\]|\\.)*")|0x([0-9a-f]+))/i.exec(metadata.stdout + metadata.stderr);
      if (!account) throw new Error("keychain_account_unavailable");
      const accountName: unknown = account[1] ? JSON.parse(account[1]) : Buffer.from(account[2]!, "hex").toString("utf8");
      if (typeof accountName !== "string" || /["\\\u0000-\u001f]/.test(accountName)) throw new Error("keychain_account_unavailable");
      // Security's interactive command parser receives the secret on stdin, never argv.
      // -X avoids the interactive parser's non-shell backslash/quote semantics.
      const command = `add-generic-password -U -s "${location.service}" -a "${accountName}" -X ${Buffer.from(raw).toString("hex")}\n`;
      await new Promise<void>((resolve, reject) => {
        const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
        let bytes = 0, failed = false;
        const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 10000);
        child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { failed = true; child.kill("SIGKILL"); } });
        child.stdin.on("error", () => { failed = true; });
        child.once("error", () => { failed = true; });
        child.once("close", code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error("keychain_write_failed")); else resolve(); });
        child.stdin.end(command);
      });
      // Interactive security can exit zero after a command failure. Verify the write.
      if (await read() !== raw) throw new Error("keychain_write_failed");
    },
  };
}

interface RecordState { root: Record<string, unknown>; oauth: Record<string, unknown>; access: string; refresh?: string; expires: number }
const parse = (raw: string): RecordState => {
  const root = object(JSON.parse(raw)), oauth = object(root?.["claudeAiOauth"]);
  if (!root || !oauth || typeof oauth["accessToken"] !== "string" || !oauth["accessToken"] || typeof oauth["expiresAt"] !== "number" || !Number.isFinite(oauth["expiresAt"])) throw new Error("invalid_claude_credentials");
  return { root, oauth, access: oauth["accessToken"], expires: oauth["expiresAt"],
    ...(typeof oauth["refreshToken"] === "string" && oauth["refreshToken"] ? { refresh: oauth["refreshToken"] } : {}) };
};
const credential = (record: RecordState): ClaudeCredential => ({ provider: "claude", authHeaders: { authorization: `Bearer ${record.access}` } });

/** Subscription only. Re-read native storage before refresh; serialize refreshes within this process. */
export class ClaudeAuthManager implements ClaudeAuth {
  private refresh: Promise<Result<ClaudeCredential, ProxyError>> | undefined;
  private lastForced = -Infinity;
  private lastAccess: string | undefined;
  constructor(private readonly options: {
    store: ClaudeCredentialStore; oauthTokenUrl: string; logger: Logger;
    fetchImpl?: typeof fetch; now?: () => number;
  }) {}
  async getCredentials(): Promise<Result<ClaudeCredential, ProxyError>> {
    try {
      const current = parse(await this.options.store.read());
      if (current.expires > this.now() + 120000 || (current.expires > this.now() && !current.refresh)) return this.remember(current);
      return this.refreshOnce(current);
    } catch { return err(authError("Cannot read Claude subscription credentials. Sign in with Claude Code or unlock its credential store.")); }
  }
  async forceRefresh(): Promise<Result<ClaudeCredential, ProxyError>> {
    if (this.refresh) return this.refresh;
    if (this.now() - this.lastForced < 30000) return this.getCredentials();
    this.lastForced = this.now();
    try {
      const current = parse(await this.options.store.read());
      if (this.lastAccess && current.access !== this.lastAccess && current.expires > this.now()) return this.remember(current);
      return this.refreshOnce(current);
    }
    catch { return err(authError("Cannot read Claude subscription credentials. Sign in with Claude Code.")); }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private remember(record: RecordState): Result<ClaudeCredential, ProxyError> { this.lastAccess = record.access; return ok(credential(record)); }
  private refreshOnce(initial: RecordState): Promise<Result<ClaudeCredential, ProxyError>> {
    if (this.refresh) return this.refresh;
    this.refresh = this.performRefresh(initial).finally(() => { this.refresh = undefined; });
    return this.refresh;
  }
  private async performRefresh(initial: RecordState): Promise<Result<ClaudeCredential, ProxyError>> {
    try {
      let current = parse(await this.options.store.read());
      if (current.access !== initial.access && current.expires > this.now()) return this.remember(current);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!current.refresh) return err(authError("Claude subscription credentials cannot be refreshed. Sign in with Claude Code."));
        const response = await (this.options.fetchImpl ?? fetch)(this.options.oauthTokenUrl, {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }),
        });
        const raw = await readBoundedText(response.body, 1024 * 1024);
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("refresh_body_limit");
        const next = object(JSON.parse(raw));
        const latest = parse(await this.options.store.read());
        if (!response.ok) {
          if (latest.access !== current.access && latest.expires > this.now()) return this.remember(latest);
          if (attempt === 0 && latest.refresh !== current.refresh && latest.refresh) { current = latest; continue; }
          this.options.logger.log("warn", "claude_token_refresh_failed", { status: response.status });
          return err(authError("Claude subscription refresh failed. Sign in with Claude Code."));
        }
        if (typeof next?.["access_token"] !== "string" || !next["access_token"] || typeof next["expires_in"] !== "number" || !Number.isFinite(next["expires_in"]) || next["expires_in"] <= 0)
          throw new Error("invalid_refresh_response");
        if (latest.access !== current.access && latest.expires > this.now()) return this.remember(latest);
        const oauth = { ...latest.oauth, accessToken: next["access_token"],
          refreshToken: typeof next["refresh_token"] === "string" ? next["refresh_token"] : current.refresh,
          expiresAt: this.now() + next["expires_in"] * 1000 };
        const written = JSON.stringify({ ...latest.root, claudeAiOauth: oauth });
        await this.options.store.write(written);
        this.options.logger.log("info", "claude_token_refreshed");
        return this.remember(parse(written));
      }
      return err(authError("Claude subscription refresh did not complete."));
    } catch {
      this.options.logger.log("warn", "claude_token_refresh_failed");
      return err(authError("Claude subscription refresh or credential persistence failed. Sign in with Claude Code."));
    }
  }
}

export async function inspectClaudeAuth(store: ClaudeCredentialStore) {
  try { const record = parse(await store.read()); return { available: true, expired: record.expires <= Date.now(), refreshable: !!record.refresh }; }
  catch { return { available: false, expired: false, refreshable: false }; }
}
