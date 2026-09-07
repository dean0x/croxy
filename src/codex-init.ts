import { homedir } from "node:os";
import { join } from "node:path";
import { parseTOML, getStaticTOMLValue } from "toml-eslint-parser";
import * as zlib from "node:zlib";
import { userConfigPath, expandHome, loadConfig, isLoopbackHost } from "./config.js";
import { object } from "./claude-contract.js";
import { planConfigWrite, planSettingsWrite, PortSchema, type InitFsDeps, type SettingsTarget } from "./init.js";

export interface SetupWrite { readonly path: string; readonly content: string; readonly preview: string }
export interface NativeSetupPaths { readonly codexConfig: string; readonly subswitchConfig: string; readonly project: string }

export function nativeSetupPaths(env: Record<string, string | undefined>, project: string): NativeSetupPaths {
  return { codexConfig: join(env["CODEX_HOME"] ?? join(homedir(), ".codex"), "config.toml"),
    subswitchConfig: env["SUBSWITCH_CONFIG"] ? expandHome(env["SUBSWITCH_CONFIG"]) : userConfigPath(env), project };
}

/** Edit only the root endpoint value, preserving comments, multiline strings, and native settings. */
export function planCodexEndpoint(source: string, port: number, mode: "subscription" | "api" = "subscription") {
  let ast: ReturnType<typeof parseTOML>;
  try { ast = parseTOML(source, { tomlVersion: "1.0.0" }); }
  catch { throw new Error("Cannot parse Codex config.toml. Fix the TOML before running init."); }
  const root = object(getStaticTOMLValue(ast));
  if (!root) throw new Error("Codex configuration must be a TOML document.");
  if (root["model_provider"] !== undefined && root["model_provider"] !== "openai")
    throw new Error("Codex uses a custom model_provider. Configure its endpoint manually; init will not replace it.");
  const previous = root["openai_base_url"];
  if (previous !== undefined && typeof previous !== "string") throw new Error("Codex openai_base_url must be a string.");
  const endpoint = `http://127.0.0.1:${port}/codex/${mode === "subscription" ? "backend-api/codex" : "v1"}`;
  const field = ast.body[0].body.find(node => node.type === "TOMLKeyValue" &&
    getStaticTOMLValue(node.key).length === 1 && getStaticTOMLValue(node.key)[0] === "openai_base_url");
  let content: string;
  if (field?.type === "TOMLKeyValue") content = source.slice(0, field.value.range[0]) + JSON.stringify(endpoint) + source.slice(field.value.range[1]);
  else content = `openai_base_url = ${JSON.stringify(endpoint)}${source.includes("\r\n") ? "\r\n" : "\n"}${source}`;
  parseTOML(content, { tomlVersion: "1.0.0" });
  return { content, endpoint, previous };
}

export async function planNativeSetup(options: {
  client: "codex" | "both"; port: number; settingsTarget: SettingsTarget; mode?: "subscription" | "api";
  codexAuthFile?: string;
}, paths: NativeSetupPaths, fs: InitFsDeps): Promise<SetupWrite[]> {
  const source = await fs.readFile(paths.codexConfig) ?? "";
  const native = planCodexEndpoint(source, options.port, options.mode);
  const existing = await fs.readFile(paths.subswitchConfig);
  let global: Record<string, unknown> | undefined;
  try { global = existing === null ? {} : object(JSON.parse(existing)); }
  catch { throw new Error("Cannot parse SubSwitch configuration JSON."); }
  if (!global) throw new Error("SubSwitch configuration must be a JSON object.");
  const ingress = object(global["codexIngress"]) ?? {};
  const claude = object(ingress["claude"]) ?? {};
  const nextIngress: Record<string, unknown> = { ...ingress, enabled: true, claude: { ...claude, enabled: true } };
  if (native.previous) {
    const previous = new URL(native.previous);
    const owned = isLoopbackHost(previous.hostname) && /^\/codex\/(?:v1|backend-api\/codex)\/?$/.test(previous.pathname);
    if (!owned) {
      if ((previous.protocol !== "https:" && !(previous.protocol === "http:" && isLoopbackHost(previous.hostname))) || previous.username || previous.password || previous.search || previous.hash)
        throw new Error("Existing Codex endpoint is not a safe HTTP(S) upstream. Configure SubSwitch manually.");
      nextIngress[options.mode === "api" ? "apiBaseUrl" : "subscriptionBaseUrl"] = native.previous;
      nextIngress["allowCustomUpstream"] = true; // Preserve the endpoint the user already selected in native Codex.
    }
  }
  const providers = object(global["providers"]) ?? {};
  const codex = object(providers["codex"]) ?? {};
  const configContent = JSON.stringify({ ...global, port: options.port, codexIngress: nextIngress,
    ...(options.codexAuthFile && codex["authFile"] === undefined ? { providers: { ...providers, codex: { ...codex, authFile: options.codexAuthFile } } } : {}),
  }, null, 2) + "\n";
  const checked = loadConfig({ configPath: paths.subswitchConfig, env: {}, readFile: () => configContent });
  if (!checked.ok) throw new Error(checked.error.message);
  const writes: SetupWrite[] = [{ path: paths.subswitchConfig, content: configContent, preview: configContent.trimEnd() }];
  let forwardSettings: SetupWrite | undefined;
  if (options.client === "both") {
    const projectConfigPath = join(paths.project, "subswitch.config.json");
    const projectConfig = planConfigWrite(projectConfigPath === paths.subswitchConfig ? configContent : await fs.readFile(projectConfigPath), options.port, paths.project);
    if (!projectConfig.ok) throw new Error(projectConfig.error.message);
    if (projectConfigPath !== paths.subswitchConfig) {
      const project = object(JSON.parse(projectConfig.value.content))!;
      const projectIngress = object(project["codexIngress"]) ?? {};
      const content = JSON.stringify({ ...project, codexIngress: { ...projectIngress, enabled: true,
        claude: { ...object(projectIngress["claude"]), enabled: true } } }, null, 2) + "\n";
      writes.push({ path: projectConfigPath, content, preview: content.trimEnd() });
    }
    const settingsPath = join(paths.project, ".claude", options.settingsTarget === "shared" ? "settings.json" : "settings.local.json");
    const settings = planSettingsWrite(await fs.readFile(settingsPath), options.port, options.settingsTarget, paths.project);
    if (!settings.ok) throw new Error(settings.error.message);
    forwardSettings = { ...settings.value, preview: `env.ANTHROPIC_BASE_URL = http://127.0.0.1:${options.port}` };
  }
  writes.push({ path: paths.codexConfig, content: native.content, preview: `openai_base_url = ${JSON.stringify(native.endpoint)} (other settings preserved)` });
  if (forwardSettings) writes.push(forwardSettings);
  return writes;
}

export async function runNativeInit(options: {
  client: "codex" | "both"; port?: string; settingsTarget?: string; dryRun: boolean;
}, fs: InitFsDeps, env: Record<string, string | undefined>, project: string, write: (line: string) => void): Promise<void> {
  if (typeof zlib.zstdDecompressSync !== "function") throw new Error("Codex → Claude setup requires Node 22.15 or newer for native zstd support.");
  const port = PortSchema.parse(options.port ?? 4141);
  if (options.settingsTarget !== undefined && options.settingsTarget !== "local" && options.settingsTarget !== "shared") throw new Error("settings-target must be local or shared.");
  const paths = nativeSetupPaths(env, project);
  let mode: "subscription" | "api" = "subscription";
  const auth = await fs.readFile(join(env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json"));
  if (auth) {
    try {
      const value = object(JSON.parse(auth));
      if (value?.["auth_mode"] === "apikey" || (!value?.["tokens"] && typeof value?.["OPENAI_API_KEY"] === "string")) mode = "api";
    } catch { /* Setup does not repair or replace credential stores; doctor diagnoses them. */ }
  } else write("Claude and Codex must be signed in before inference; run doctor after setup.");
  const plans = await planNativeSetup({ client: options.client, port, settingsTarget: options.settingsTarget ?? "local", mode,
    ...(env["CODEX_HOME"] ? { codexAuthFile: join(env["CODEX_HOME"], "auth.json") } : {}),
  }, paths, fs);
  for (const plan of plans) {
    if (options.dryRun) { write(`[dry-run] Would update ${plan.path}:`); write(plan.preview); }
    else { await fs.writeFile(plan.path, plan.content); write(`Written: ${plan.path}`); }
  }
  write(options.dryRun ? "[dry-run] No files written." : "Next: run subswitch serve, then subswitch doctor --client codex. Native agents can use model sonnet, opus, or fable.");
}
