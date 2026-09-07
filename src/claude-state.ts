/** Authenticated process-local Claude thinking state. No persistent credential or key writes. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { object } from "./claude-contract.js";
import { ReverseContractError, type Item } from "./claude-adapter.js";
import { ReasoningCache } from "./reasoning-cache.js";

export interface ClaudeReplay { content: Item[]; output: Item[] }
export class ReverseState {
  private readonly references: ReasoningCache;
  constructor(private readonly key: Buffer = randomBytes(32), limits = { maxEntries: 4096, maxBytes: 64 * 1024 * 1024 }) {
    if (key.length !== 32) throw new ReverseContractError("invalid_state_key");
    this.references = new ReasoningCache(limits.maxEntries, limits.maxBytes);
  }
  seal(value: ClaudeReplay): string {
    return this.encrypt({ version: 1, provider: "claude", ...value });
  }
  /** Issue a stable opaque handle before streaming text; commit only validated terminal content. */
  begin(): { token: string; commit(value: ClaudeReplay): void } {
    const reference = randomUUID();
    return { token: this.encrypt({ version: 1, provider: "claude", reference }),
      commit: value => this.references.put(reference, [value]) };
  }
  private encrypt(value: Item): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from("subswitch:claude-replay:v1"));
    const bytes = Buffer.from(JSON.stringify(value));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return `subswitch-claude-v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
  }
  open(token: string): ClaudeReplay {
    if (!token.startsWith("subswitch-claude-v1.")) throw new ReverseContractError("foreign_opaque_state");
    try {
      const bytes = Buffer.from(token.slice("subswitch-claude-v1.".length), "base64url");
      if (bytes.length < 29 || bytes.length > 4 * 1024 * 1024) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from("subswitch:claude-replay:v1")); decipher.setAuthTag(bytes.subarray(12, 28));
      const parsed = object(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")));
      if (parsed?.["version"] !== 1 || parsed["provider"] !== "claude") throw new Error();
      if (typeof parsed["reference"] === "string") {
        const value = this.references.get(parsed["reference"])?.[0] as ClaudeReplay | undefined;
        if (!value) throw new ReverseContractError("missing_claude_replay_state");
        return value;
      }
      if (!Array.isArray(parsed["content"]) || !Array.isArray(parsed["output"])) throw new Error();
      return { content: parsed["content"] as Item[], output: parsed["output"] as Item[] };
    } catch (error) { if (error instanceof ReverseContractError) throw error; throw new ReverseContractError("invalid_opaque_state"); }
  }
}

/** Bind state to meaningful native call/message fields; clients may omit status and item IDs. */
export function replayIdentity(entry: Item): string {
  const type = entry["type"] ?? (entry["role"] ? "message" : undefined);
  if (type === "message") {
    const content = entry["content"];
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(value => {
      const block = object(value);
      return block && ["input_text", "output_text", "text"].includes(String(block["type"])) ? { type: "text", text: block["text"] } : value;
    }) : content;
    return JSON.stringify([type, entry["role"], blocks]);
  }
  let args = entry["arguments"] ?? entry["input"];
  if (type === "function_call" && typeof args === "string") { try { args = canonicalObject(JSON.parse(args)); } catch {} }
  return JSON.stringify([type, entry["call_id"], entry["namespace"] ?? null, entry["name"], args]);
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  const obj = object(value);
  return obj ? Object.fromEntries(Object.keys(obj).sort().map(key => [key, canonicalObject(obj[key])])) : value;
}
