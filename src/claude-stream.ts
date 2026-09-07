import { randomUUID } from "node:crypto";
import { object } from "./claude-contract.js";
import { reverseResponse, reverseEvents, ReverseContractError, type Item, type ReverseRequest } from "./claude-adapter.js";
import type { ReverseState } from "./claude-state.js";
import type { SseEvent } from "./codex-response.js";

/** Incremental text with authenticated thinking replay; executable calls commit only at message_stop. */
export async function* translateClaudeStream(source: AsyncIterable<SseEvent>, options: {
  id: string; model: string; request: ReverseRequest; state: ReverseState; maxBytes: number;
}): AsyncGenerator<Item> {
  const { id, model } = options;
  const reasoningId = `rs_${randomUUID()}`;
  const replay = options.state.begin();
  const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] };
  let sequence = 0, size = 0, started = false, ended = false, nextOutput = 1;
  let stopReason: unknown, usage: Item = {};
  const blocks: Item[] = [], open = new Set<number>();
  const argumentsByIndex = new Map<number, string>();
  const nativeIndexes = new Map<number, number>(), identities = new Map<number, string>();
  const streamedText = new Set<string>();
  let toolSeen = false;
  const frame = (event: Item): Item => ({ ...event, sequence_number: sequence++ });
  function fail(code: string): never { throw new ReverseContractError(code); }
  for await (const incoming of source) {
    size += Buffer.byteLength(incoming.data);
    if (size > options.maxBytes) fail("claude_response_too_large");
    let event: Item | undefined;
    try { event = object(JSON.parse(incoming.data)); } catch { fail("invalid_claude_event"); }
    if (!event || typeof event["type"] !== "string") fail("invalid_claude_event");
    if (event["type"] === "ping") continue;
    if (ended) fail("claude_event_after_terminal");
    if (event["type"] === "error") fail("claude_stream_error");
    if (event["type"] === "message_start") {
      if (started) fail("duplicate_claude_start");
      const message = object(event["message"]);
      if (message?.["type"] !== "message") fail("invalid_claude_start");
      started = true; usage = object(message["usage"]) ?? {};
      yield frame({ type: "response.created", response: base });
      yield frame({ type: "response.in_progress", response: base });
      const reasoning = { type: "reasoning", id: reasoningId, summary: [], encrypted_content: replay.token };
      yield frame({ type: "response.output_item.added", output_index: 0, item: reasoning });
      yield frame({ type: "response.output_item.done", output_index: 0, item: reasoning });
      continue;
    }
    if (!started) fail("missing_claude_start");
    if (event["type"] === "content_block_start") {
      const index = event["index"], block = object(event["content_block"]);
      if (typeof index !== "number" || index !== blocks.length || !block) fail("invalid_claude_block_index");
      if (!["text", "tool_use", "thinking", "redacted_thinking"].includes(String(block["type"]))) fail("unsupported_claude_output");
      blocks.push({ ...block }); open.add(index);
      if (block["type"] === "tool_use") {
        toolSeen = true;
        if (typeof block["name"] !== "string" || !options.request.tools.has(block["name"])) fail("unknown_claude_tool");
        argumentsByIndex.set(index, "");
      }
      if (block["type"] === "text" || block["type"] === "tool_use") {
        const itemId = `${block["type"] === "text" ? "msg" : "fc"}_${randomUUID()}`;
        identities.set(index, itemId); nativeIndexes.set(index, nextOutput++);
        if (block["type"] === "text" && !toolSeen) {
          streamedText.add(itemId);
          const output_index = nativeIndexes.get(index)!;
          yield frame({ type: "response.output_item.added", output_index, item: {
            type: "message", id: itemId, role: "assistant", status: "in_progress", phase: "final_answer", content: [],
          } });
          yield frame({ type: "response.content_part.added", output_index, item_id: itemId, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] } });
          if (typeof block["text"] === "string" && block["text"]) yield frame({ type: "response.output_text.delta", output_index, item_id: itemId, content_index: 0, delta: block["text"] });
        }
      }
    } else if (event["type"] === "content_block_delta") {
      const index = event["index"], delta = object(event["delta"]);
      if (typeof index !== "number" || !open.has(index) || !delta) fail("invalid_claude_delta");
      const block = blocks[index]!;
      if (delta["type"] === "text_delta" && block["type"] === "text" && typeof delta["text"] === "string") {
        block["text"] = String(block["text"] ?? "") + delta["text"];
        if (streamedText.has(identities.get(index)!)) yield frame({ type: "response.output_text.delta", item_id: identities.get(index), output_index: nativeIndexes.get(index), content_index: 0, delta: delta["text"] });
      } else if (delta["type"] === "input_json_delta" && block["type"] === "tool_use" && typeof delta["partial_json"] === "string") {
        argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? "") + delta["partial_json"]);
      } else if (delta["type"] === "thinking_delta" && block["type"] === "thinking" && typeof delta["thinking"] === "string") {
        block["thinking"] = String(block["thinking"] ?? "") + delta["thinking"];
      } else if (delta["type"] === "signature_delta" && block["type"] === "thinking" && typeof delta["signature"] === "string") {
        block["signature"] = String(block["signature"] ?? "") + delta["signature"];
      } else fail("unsupported_claude_delta");
    } else if (event["type"] === "content_block_stop") {
      const index = event["index"];
      if (typeof index !== "number" || !open.delete(index)) fail("invalid_claude_block_stop");
      const partial = argumentsByIndex.get(index);
      if (partial) {
        try { blocks[index]!["input"] = object(JSON.parse(partial)) ?? fail("invalid_tool_arguments"); }
        catch { fail("invalid_tool_arguments"); }
      }
    } else if (event["type"] === "message_delta") {
      const delta = object(event["delta"]); if (!delta) fail("invalid_claude_message_delta");
      if (delta["stop_reason"] !== undefined && delta["stop_reason"] !== null) stopReason = delta["stop_reason"];
      usage = { ...usage, ...object(event["usage"]) };
    } else if (event["type"] === "message_stop") {
      if (open.size) fail("unterminated_claude_block");
      ended = true;
      const incomplete = stopReason === "max_tokens";
      const response = { type: "message", stop_reason: incomplete || stopReason === "refusal" ? "end_turn" : stopReason,
        content: incomplete ? blocks.filter(block => block["type"] === "text") : blocks };
      const selectedIdentities = incomplete ? new Map(blocks.map((block, index) => ({ block, id: identities.get(index) })).filter(entry => entry.block["type"] === "text").map((entry, index) => [index, entry.id!])) : identities;
      const output = reverseResponse(response, options.request, options.state, selectedIdentities, replay.token);
      output[0]!["id"] = reasoningId;
      replay.commit({ content: response.content, output: output.slice(1) });
      const complete = reverseEvents(id, model, output, usage);
      for (const event of complete) {
        const type = event["type"];
        if (["response.created", "response.in_progress"].includes(String(type))) continue;
        if (type === "response.output_item.done" && object(event["item"])?.["type"] === "reasoning") continue;
        if (type === "response.output_item.added" && (object(event["item"])?.["type"] === "reasoning" || streamedText.has(String(object(event["item"])?.["id"])))) continue;
        if ((type === "response.content_part.added" || type === "response.output_text.delta") && streamedText.has(String(event["item_id"]))) continue;
        if (type === "response.completed" && incomplete) {
          yield frame({ type: "response.incomplete", response: { ...object(event["response"]), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
        } else yield frame(event);
      }
    } else fail("unsupported_claude_event");
  }
  if (!ended) fail("missing_claude_terminal");
}
