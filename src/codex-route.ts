export type ClaudeResolution =
  | { readonly kind: "claude"; readonly model: string }
  | { readonly kind: "foreign" }
  | { readonly kind: "absent" };

export type CodexRoute =
  | { readonly kind: "claude"; readonly model: string }
  | { readonly kind: "parent" }
  | { readonly kind: "rejected"; readonly code: "translated_compaction_unavailable" };

/** Resolution precedes dispatch; HTTP and WebSocket dispatch do no model-name matching. */
export const decideCodexRoute = (path: string, resolution: ClaudeResolution): CodexRoute => {
  switch (resolution.kind) {
    case "claude":
      return path === "/responses/compact"
        ? { kind: "rejected", code: "translated_compaction_unavailable" }
        : { kind: "claude", model: resolution.model };
    case "foreign":
    case "absent":
      return { kind: "parent" };
    default: {
      const exhaustive: never = resolution;
      return exhaustive;
    }
  }
};
