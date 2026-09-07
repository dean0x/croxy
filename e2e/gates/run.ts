import { pathToFileURL } from "node:url";
import { CredentialUnavailable, probeHeaders } from "./credentials.js";
import { reportExitCode, runProbe, type GateAuth, type GateProvider } from "./probe.js";

export function parseArgs(args: readonly string[]): {
  provider: GateProvider; auth: GateAuth; model: string; envName?: string; contract?: "native-history" | "native-arguments" | "schema-fields" | "namespace-control";
} {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!flag || !["--provider", "--auth", "--model", "--key-env", "--contract"].includes(flag) ||
      !value || value.startsWith("--") || values.has(flag)) throw new Error("invalid_arguments");
    values.set(flag, value);
  }
  const provider = values.get("--provider");
  const auth = values.get("--auth") ?? "subscription";
  const model = values.get("--model");
  const envName = values.get("--key-env");
  const contract = values.get("--contract");
  if ((provider !== "claude" && provider !== "openai") || (auth !== "api" && auth !== "subscription") ||
    !model || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model) ||
    (envName !== undefined && (auth !== "api" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName))) ||
    (contract !== undefined && (provider !== "openai" || (contract !== "native-history" && contract !== "native-arguments" && contract !== "schema-fields" && contract !== "namespace-control")))) {
    throw new Error("invalid_arguments");
  }
  return { provider, auth, model, ...(envName === undefined ? {} : { envName }), ...(contract ? { contract } : {}) };
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") {
    process.stdout.write("Usage: npm run probe:compat -- --provider openai|claude --model <id> [--auth subscription|api] [--key-env NAME] [--contract native-history|native-arguments|schema-fields|namespace-control]\n" +
      "Live, fixed-prompt checks. Subscription is the default. No tools are executed.\n" +
      "Exit 0: selected checks pass; 1: contract/arguments fail; 2: credentials, network, or upstream rejection block the check.\n");
    return;
  }
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch {
    process.stderr.write("Invalid probe arguments. Run npm run probe:compat -- --help.\n");
    process.exitCode = 1; return;
  }
  try {
    const headers = await probeHeaders(options);
    const report = await runProbe({ ...options, headers });
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exitCode = reportExitCode(report);
  } catch (error) {
    const code = error instanceof CredentialUnavailable ? error.code : "probe_setup_failed";
    process.stdout.write(JSON.stringify({
      schemaVersion: 1, provider: options.provider, auth: options.auth,
      results: [{ gate: "credentials", status: "blocked", code }],
    }) + "\n");
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
