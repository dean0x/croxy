/** Source protocol/endpoint selection is independent of destination model resolution. */
export type CodexEndpointMode = "subscription" | "api";

const BASES = {
  subscription: "/codex/backend-api/codex",
  api: "/codex/v1",
} as const;

export type CodexIngressRoute =
  | { readonly kind: "other" }
  | { readonly kind: "reserved" }
  | { readonly kind: "codex"; readonly mode: CodexEndpointMode; readonly path: string };

/** Never normalize paths or parse query strings: untouched traffic keeps its wire target. */
export function codexIngressRoute(rawPath: string): CodexIngressRoute {
  const pathname = rawPath.split("?", 1)[0] ?? rawPath;
  if (pathname !== "/codex" && !pathname.startsWith("/codex/")) return { kind: "other" };
  for (const mode of ["subscription", "api"] as const) {
    const base = BASES[mode];
    if (pathname === base || pathname.startsWith(`${base}/`)) {
      const suffix = rawPath.slice(base.length);
      return { kind: "codex", mode, path: suffix };
    }
  }
  return { kind: "reserved" };
}

export const openaiErrorBody = (message: string, code = "subswitch_upstream_error"): string =>
  JSON.stringify({ error: { message, type: "api_error", param: null, code } });
