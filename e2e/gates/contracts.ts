import { readFileSync } from "node:fs";
/** Native tool schema from an isolated fake-upstream run. All message/history values are fabricated. */
// An empty list is the native protocol marker. The similarly named strings in
// Codex's source are log-redaction labels, not wire values.
export const PLAINTEXT_ARGUMENTS: readonly string[] = Object.freeze([]);
export const TASK = "Reply with gate-ok.";

interface NativeNamespace {
  type: string;
  name: string;
  tools: { name: string; parameters: { properties: Record<string, { encrypted?: boolean }> } }[];
}

export const collaborationTools = (plaintext = true): NativeNamespace => {
  const namespace: NativeNamespace = JSON.parse(readFileSync(new URL(
    "../../test/fixtures/native/codex-0.153.3-collaboration.json", import.meta.url,
  ), "utf8"));
  if (plaintext) for (const tool of namespace.tools) {
    if (["spawn_agent", "send_message", "followup_task"].includes(tool.name)) {
      const message = tool.parameters.properties["message"];
      if (!message || message.encrypted !== true) throw new Error("native_fixture_drift");
      message.encrypted = false;
    }
  }
  return namespace;
};

export const openaiSchemaRequest = (model: string, plaintext = true) => ({
  model,
  input: [
    { type: "additional_tools", id: "at_subswitch_gate", role: "developer", tools: [collaborationTools(plaintext)] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Say gate-ok. Do not call tools." }] },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
  store: false,
  stream: true,
});

export const openaiArgumentsRequest = (model: string) => {
  const request = openaiSchemaRequest(model);
  request.input[1] = {
    type: "message", role: "user", content: [{ type: "input_text", text:
      `Call collaboration.spawn_agent once with task_name probe and message exactly ${JSON.stringify(TASK)}.` }],
  };
  return request;
};

export const openaiSchemaFieldRequest = (
  model: string, name: "spawn_agent" | "send_message" | "followup_task", mode: "false" | "omit",
) => {
  const request = openaiSchemaRequest(model, false);
  const namespace = request.input[0]!.tools![0]!;
  const message = namespace.tools.find((tool) => tool.name === name)?.parameters.properties["message"];
  if (!message || message.encrypted !== true) throw new Error("native_fixture_drift");
  if (mode === "omit") delete message.encrypted;
  else message.encrypted = false;
  return request;
};

export const openaiNativeArgumentsRequest = (model: string) => {
  const request = openaiSchemaRequest(model, false);
  request.input[1] = { type: "message", role: "user", content: [{ type: "input_text", text:
    `Call collaboration.spawn_agent once with task_name probe, model claude-sonnet-5, fork_turns none, and message exactly ${JSON.stringify(TASK)}.` }] };
  return request;
};

export const openaiMarkerRequest = (model: string, plaintextSchema = true) => ({
  ...openaiSchemaRequest(model, plaintextSchema),
  input: [
    { type: "additional_tools", id: "at_subswitch_gate", role: "developer", tools: [collaborationTools(plaintextSchema)] },
    { type: "message", role: "user", content: "Run the fixed compatibility check." },
    {
      type: "function_call", id: "fc_subswitch_gate", call_id: "call_subswitch_gate",
      namespace: "collaboration", name: "spawn_agent",
      arguments: JSON.stringify({ task_name: "probe", message: TASK }),
      encrypted_function_args: PLAINTEXT_ARGUMENTS,
    },
    {
      type: "function_call_output", call_id: "call_subswitch_gate",
      output: JSON.stringify({ agent_id: "probe", task_name: "/root/probe" }),
    },
    {
      type: "agent_message", id: "amsg_subswitch_gate", author: "/root/probe", recipient: "/root",
      content: [{ type: "input_text", text: "gate-ok" }],
    },
    { type: "message", role: "user", content: "The fabricated probe agent has finished. Reply with gate-ok and do not call tools." },
  ],
});

export const claudeToolRequest = (model: string) => ({
  model,
  max_tokens: 128,
  messages: [{ role: "user", content: "Call echo with text gate-ok." }],
  tools: [{
    name: "echo", description: "Return a fixed compatibility test value.",
    input_schema: {
      type: "object", properties: { text: { type: "string" } },
      required: ["text"], additionalProperties: false,
    },
  }],
  tool_choice: { type: "tool", name: "echo" },
});
