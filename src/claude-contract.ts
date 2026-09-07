export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectValue : undefined;

/** Explicit subscription wire compatibility; never applied to the forward passthrough. */
export const CLAUDE_SUBSCRIPTION_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";
