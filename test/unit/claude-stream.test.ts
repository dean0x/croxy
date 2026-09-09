import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateClaudeStream } from "../../src/claude-stream.js";
import { reverseRequest, ReverseContractError, type Item } from "../../src/claude-adapter.js";
import { ReverseState } from "../../src/claude-state.js";

const request = reverseRequest({ model: "claude-sonnet-5", input: "Read a fixture", tools: [
  { type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
] });
const wire = [...request.tools.keys()][0]!;
const frames = async function* (events: Item[]) { for (const event of events) yield { event: String(event["type"]), data: JSON.stringify(event) }; };
const start = { type: "message_start", message: { type: "message", usage: { input_tokens: 10 } } };
const terminal = (reason = "end_turn") => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 5 } }, { type: "message_stop" }];
const options = () => ({ id: "resp_test", model: "claude-sonnet-5", request, state: new ReverseState(), maxBytes: 65536 });
const gather = async (events: Item[]) => {
  const output: Item[] = [];
  for await (const event of translateClaudeStream(frames(events), options())) output.push(event);
  return output;
};

describe("Claude streaming translation", () => {
  it("can continue cancelled output using readable history without replaying unfinished thinking", async () => {
    const config = options();
    const emitted: Item[] = [];
    for await (const event of translateClaudeStream(frames([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "private unfinished", signature: "unfinished-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "partial answer" } },
    ]), config)) {
      emitted.push(event);
      if (event["type"] === "response.output_text.delta") break;
    }
    const reasoning = emitted.find(event => event["type"] === "response.output_item.done")?.["item"] as Item;
    const notice = "<turn_aborted>\nThe previous turn was interrupted on purpose. Tools may have partially executed.\n</turn_aborted>";
    const next = reverseRequest({ model: "claude-sonnet-5", input: [
      { role: "user", content: "Original question" }, reasoning,
      { role: "assistant", content: [{ type: "output_text", text: "partial answer" }] },
      { role: "developer", content: [{ type: "input_text", text: notice }] },
      { role: "user", content: "Continue" },
    ] }, [], config.state);
    assert.deepEqual(next.body["messages"], [
      { role: "user", content: [{ type: "text", text: "Original question" }] },
      { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
      { role: "user", content: [{ type: "text", text: notice }, { type: "text", text: "Continue" }] },
    ]);
    assert.ok(!JSON.stringify(next.body).includes("unfinished"));
    assert.throws(() => reverseRequest({ model: "claude-sonnet-5", input: [
      { role: "user", content: "Original" }, { role: "developer", content: "Arbitrary new instructions" },
    ] }, [], config.state), /mid_history_instructions_unimplemented/);
    assert.throws(() => new ReverseState().open(String(reasoning["encrypted_content"])), /invalid_opaque_state/);
  });

  it("emits text before upstream completion with stable item identities", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const source = async function* () {
      yield* frames([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello ü" } }]);
      await pending;
      yield* frames([{ type: "content_block_stop", index: 0 }, ...terminal()]);
    };
    const stream = translateClaudeStream(source(), options());
    const output: Item[] = [];
    while (true) { const event = await stream.next(); assert.equal(event.done, false); output.push(event.value!); if (event.value?.["type"] === "response.output_text.delta") break; }
    release(); for await (const event of stream) output.push(event);
    const delta = output.find(event => event["type"] === "response.output_text.delta")!;
    const final = output.find(event => event["type"] === "response.output_text.done")!;
    assert.equal(delta["item_id"], final["item_id"]); assert.equal(final["text"], "Hello ü");
    assert.equal(output.at(-1)?.["type"], "response.completed");
    assert.deepEqual(output.map(event => event["sequence_number"]), output.map((_, index) => index));
  });

  it("commits valid tools only after message_stop and preserves thinking signatures", async () => {
    const output = await gather([start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private fixture" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-fixture" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_fixture", name: wire, input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
      { type: "content_block_stop", index: 1 }, ...terminal("tool_use")]);
    assert.equal(output.find(event => event["type"] === "response.function_call_arguments.done")?.["arguments"], '{"path":"a.txt"}');
    assert.ok(!JSON.stringify(output).includes("signed-fixture"));
    assert.ok(!JSON.stringify(output).includes("private fixture"));
    const final = output.at(-1)?.["response"] as Item;
    assert.equal((final["output"] as Item[])[0]?.["type"], "reasoning");
  });

  it("does not emit an executable call from truncated or malformed streams", async () => {
    const prefix = [start, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: wire, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
      { type: "content_block_stop", index: 0 }];
    const output: Item[] = [];
    await assert.rejects(async () => { for await (const event of translateClaudeStream(frames(prefix), options())) output.push(event); },
      error => error instanceof ReverseContractError && error.code === "missing_claude_terminal");
    assert.ok(!output.some(event => event["type"] === "response.function_call_arguments.done" ||
      (event["type"] === "response.output_item.done" && ["function_call", "custom_tool_call"].includes(String((event["item"] as Item)?.["type"])))));
    await assert.rejects(() => gather([start, { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }]),
      error => error instanceof ReverseContractError && error.code === "invalid_claude_block_index");
  });
  it("reports output limits without committing tools and keeps streamed text identities", async () => {
    const output = await gather([start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "before" } }, { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_limit", name: wire, input: {} } }, { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "after" } }, { type: "content_block_stop", index: 2 },
      ...terminal("max_tokens")]);
    assert.equal(output.at(-1)?.["type"], "response.incomplete");
    assert.ok(!output.some(event => event["type"] === "response.function_call_arguments.done"));
    const added = output.filter(event => event["type"] === "response.output_item.added" && (event["item"] as Item)["type"] === "message");
    const done = output.filter(event => event["type"] === "response.output_item.done" && (event["item"] as Item)["type"] === "message");
    assert.deepEqual(added.map(event => [(event["item"] as Item)["id"], event["output_index"]]), done.map(event => [(event["item"] as Item)["id"], event["output_index"]]));
  });
});
