import { z } from "zod";
import type { Config } from "./config.js";
import { CLAUDE_MODELS } from "./claude-models.js";

export const CodexIngressHealthSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  mode: z.enum(["model-routing", "passthrough"]),
  translationAvailable: z.boolean(),
  credentials: z.literal("client"),
  transports: z.array(z.enum(["http", "websocket"])),
  subscriptionAuth: z.literal("native-store").optional(),
  claudeModelCount: z.number().int().nonnegative().optional(),
});
export type CodexIngressHealth = z.infer<typeof CodexIngressHealthSchema>;

export const codexIngressHealth = (config: Config): CodexIngressHealth | undefined => {
  if (!config.codexIngress.enabled) return undefined;
  const enabled = config.codexIngress.claude.enabled;
  return {
    schemaVersion: 1,
    enabled: true,
    mode: enabled ? "model-routing" : "passthrough",
    translationAvailable: enabled,
    credentials: "client",
    transports: ["http", "websocket"],
    ...(enabled ? { subscriptionAuth: "native-store", claudeModelCount: CLAUDE_MODELS.length } : {}),
  };
};
