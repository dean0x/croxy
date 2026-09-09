import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRIDGE_NAMESPACE, NamespaceContractError, namespaceRequest, namespaceEvent } from "../../src/collaboration-compat.js";
import { collaborationTools } from "../../e2e/gates/contracts.js";

describe("experimental collaboration namespace protocol adapter", () => {
  it("maps schemas, replayed calls and tool choices without editing prompt or opaque content", () => {
    const message = { type: "message", role: "user", content: "Literal collaboration.spawn_agent must stay intact." };
    const reasoning = { type: "reasoning", encrypted_content: "fabricated-opaque-state" };
    const call = { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "call_fixture", arguments: '{"message":"original"}' };
    const namespace = collaborationTools(false);
    const request = { input: [{ type: "additional_tools", tools: [namespace] }, message, reasoning, call],
      tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", namespace: "collaboration", name: "spawn_agent" }] } };
    const before = structuredClone(request);
    const mapped = namespaceRequest(request) as typeof request;
    assert.deepEqual(request, before);
    assert.equal(mapped.input[1], message);
    assert.equal(mapped.input[2], reasoning);
    assert.deepEqual(mapped.input[3], { ...call, namespace: BRIDGE_NAMESPACE });
    assert.equal(mapped.tool_choice.tools[0]?.namespace, BRIDGE_NAMESPACE);
    const changed = (mapped.input[0] as { tools: ReturnType<typeof collaborationTools>[] }).tools[0]!;
    assert.equal(changed.name, BRIDGE_NAMESPACE);
    for (const tool of changed.tools) if (["spawn_agent", "send_message", "followup_task"].includes(tool.name))
      assert.equal(tool.parameters.properties["message"]?.encrypted, false);
  });

  it("keeps native identity and plaintext metadata consistent across streaming events", () => {
    const item = { type: "function_call", namespace: BRIDGE_NAMESPACE, name: "spawn_agent", id: "fc_fixture", call_id: "call_fixture", arguments: "" };
    const added = namespaceEvent({ type: "response.output_item.added", output_index: 2, item });
    assert.deepEqual(added["item"], { ...item, namespace: "collaboration", encrypted_function_args: [] });
    const complete = { ...item, arguments: '{"message":"known plaintext"}' };
    const expected = { ...complete, namespace: "collaboration", encrypted_function_args: [] };
    assert.deepEqual(namespaceEvent({ type: "response.output_item.done", output_index: 2, item: complete })["item"], expected);
    const final = namespaceEvent({ type: "response.completed", response: { id: "resp_fixture", output: [complete] } });
    assert.deepEqual(final["response"], { id: "resp_fixture", output: [expected] });
    assert.equal(complete.namespace, BRIDGE_NAMESPACE);
  });

  it("rejects incomplete arguments and explicit encryption instead of making an executable call", () => {
    for (const item of [
      { arguments: '{"message":' },
      { arguments: '{"message":17}' },
      { arguments: '{"message":"fabricated opaque"}', encrypted_function_args: ["message"] },
      { arguments: '{"message":"text"}', encrypted_function_args: "[plaintext arguments]" },
    ]) assert.throws(() => namespaceEvent({ type: "response.output_item.done", item: {
      type: "function_call", namespace: BRIDGE_NAMESPACE, name: "send_message", ...item,
    } }), (error: unknown) => error instanceof NamespaceContractError && error.code === "invalid_plaintext_call");
  });

  it("leaves original native encryption and unrelated output untouched", () => {
    const encryptedCall = { type: "function_call", namespace: "collaboration", name: "spawn_agent", arguments: "fabricated opaque" };
    const event = { type: "response.output_item.done", item: encryptedCall };
    assert.equal(namespaceEvent(event)["item"], encryptedCall);
    const reasoning = { type: "reasoning", encrypted_content: "fabricated opaque" };
    assert.equal(namespaceEvent({ type: "response.output_item.done", item: reasoning })["item"], reasoning);
    const agentMessage = { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "fabricated opaque" }] };
    assert.deepEqual(namespaceRequest({ input: [agentMessage] }), { input: [agentMessage] });
  });

  it("fails explicitly on an existing namespace collision", () => {
    for (const request of [
      { tools: [{ type: "namespace", name: BRIDGE_NAMESPACE, tools: [] }] },
      { input: [{ type: "additional_tools", tools: [{ type: "namespace", name: BRIDGE_NAMESPACE, tools: [] }] }] },
    ]) assert.throws(() => namespaceRequest(request),
      (error: unknown) => error instanceof NamespaceContractError && error.code === "namespace_collision");
  });
});
