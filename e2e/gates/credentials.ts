import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { object, type GateProvider, type GateAuth } from "./probe.js";

const exec = promisify(execFile);

export class CredentialUnavailable extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface CredentialOptions {
  readonly provider: GateProvider;
  readonly auth: GateAuth;
  readonly envName?: string;
}

export interface CredentialDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly read: (path: string) => Promise<string>;
  readonly keychain: (service: string) => Promise<string>;
  readonly now: () => number;
}

const actualDeps: CredentialDeps = {
  env: process.env, home: homedir(), platform: process.platform,
  read: (path) => readFile(path, "utf8"), now: Date.now,
  keychain: async (service) => (await exec("security", ["find-generic-password", "-s", service, "-w"], {
    timeout: 10_000, maxBuffer: 1024 * 1024,
  })).stdout,
};

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Read-only gate discovery; expired credentials require the native client to refresh. */
export async function probeHeaders(options: CredentialOptions, deps = actualDeps): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json", "user-agent": "subswitch-compatibility-probe/0.4.0",
    accept: options.provider === "openai" ? "text/event-stream" : "application/json",
  };
  if (options.provider === "claude") headers["anthropic-version"] = "2023-06-01";
  if (options.auth === "api") {
    const name = options.envName ?? (options.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
    const token = deps.env[name];
    if (!nonempty(token)) throw new CredentialUnavailable("api_key_env_missing");
    headers[options.provider === "openai" ? "authorization" : "x-api-key"] =
      options.provider === "openai" ? `Bearer ${token}` : token;
    return headers;
  }
  if (options.envName !== undefined) throw new CredentialUnavailable("env_requires_api_mode");
  try {
    if (options.provider === "openai") {
      const raw = await deps.read(join(deps.env["CODEX_HOME"] ?? join(deps.home, ".codex"), "auth.json"));
      const tokens = object(object(JSON.parse(raw))?.["tokens"]);
      const token = tokens?.["access_token"];
      if (!nonempty(token)) throw new CredentialUnavailable("codex_subscription_missing");
      let claims: Record<string, unknown> | undefined;
      try { claims = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))); }
      catch { /* Native files can contain an opaque access token with an explicit account ID. */ }
      if (typeof claims?.["exp"] === "number" && claims["exp"] * 1000 <= deps.now()) {
        throw new CredentialUnavailable("codex_subscription_expired");
      }
      const account = tokens?.["account_id"] ?? object(claims?.["https://api.openai.com/auth"])?.["chatgpt_account_id"];
      if (!nonempty(account)) throw new CredentialUnavailable("codex_account_missing");
      headers["authorization"] = `Bearer ${token}`;
      headers["chatgpt-account-id"] = account;
      headers["openai-beta"] = "responses=experimental";
    } else {
      const configDir = deps.env["CLAUDE_CONFIG_DIR"];
      const directory = configDir ?? join(deps.home, ".claude");
      // Native Claude Code isolates Keychain services for explicit configuration dirs.
      const service = "Claude Code-credentials" + (configDir === undefined ? "" :
        `-${createHash("sha256").update(resolve(configDir)).digest("hex").slice(0, 8)}`);
      const raw = deps.platform === "darwin" ? await deps.keychain(service) :
        await deps.read(join(directory, ".credentials.json"));
      const oauth = object(object(JSON.parse(raw))?.["claudeAiOauth"]);
      if (!nonempty(oauth?.["accessToken"])) throw new CredentialUnavailable("claude_subscription_missing");
      if (typeof oauth["expiresAt"] !== "number" || oauth["expiresAt"] <= deps.now()) {
        throw new CredentialUnavailable("claude_subscription_expired");
      }
      headers["authorization"] = `Bearer ${oauth["accessToken"]}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }
  } catch (error) {
    if (error instanceof CredentialUnavailable) throw error;
    throw new CredentialUnavailable(options.provider === "claude" && deps.platform === "darwin" ?
      "claude_keychain_unavailable" : "credential_file_unavailable");
  }
  return headers;
}
