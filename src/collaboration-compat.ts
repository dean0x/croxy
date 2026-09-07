/** Reversible collaboration namespace compatibility for reverse-enabled Codex sessions. */
export const BRIDGE_NAMESPACE = "subswitch_collaboration";
const NATIVE_NAMESPACE = "collaboration";
const MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"]);
const TOOLS = new Set([...MESSAGE_TOOLS, "wait_agent", "list_agents", "interrupt_agent"]);
type Item = Record<string, unknown>;
const object = (value: unknown): Item | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Item : undefined;

export class NamespaceContractError extends Error {
  constructor(readonly code: "namespace_collision" | "invalid_plaintext_call") { super(code); }
}

function definitions(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry: unknown) => {
    const tool = object(entry);
    if (tool?.["type"] !== "namespace") return entry;
    if (tool["name"] === BRIDGE_NAMESPACE) throw new NamespaceContractError("namespace_collision");
    if (tool["name"] !== NATIVE_NAMESPACE || !Array.isArray(tool["tools"])) return entry;
    const tools = tool["tools"].map((value: unknown) => {
      const fn = object(value);
      if (!fn || !MESSAGE_TOOLS.has(String(fn["name"]))) return value;
      const parameters = object(fn["parameters"]), properties = object(parameters?.["properties"]);
      const message = object(properties?.["message"]);
      if (!parameters || !properties || !message) throw new NamespaceContractError("invalid_plaintext_call");
      return { ...fn, parameters: { ...parameters, properties: { ...properties, message: { ...message, encrypted: false } } } };
    });
    return { ...tool, name: BRIDGE_NAMESPACE, tools };
  });
}

function inputItem(value: unknown): unknown {
  const item = object(value);
  if (item?.["type"] === "additional_tools") return { ...item, tools: definitions(item["tools"]) };
  if (item?.["type"] === "function_call" && item["namespace"] === NATIVE_NAMESPACE)
    return { ...item, namespace: BRIDGE_NAMESPACE };
  return value;
}

function toolChoice(value: unknown): unknown {
  const choice = object(value);
  if (choice?.["type"] === "function" && choice["namespace"] === NATIVE_NAMESPACE)
    return { ...choice, namespace: BRIDGE_NAMESPACE };
  if (choice?.["type"] === "allowed_tools" && Array.isArray(choice["tools"]))
    return { ...choice, tools: choice["tools"].map(toolChoice) };
  return value;
}

/** Map structured protocol fields only. Never replace text inside prompts or arguments. */
export function namespaceRequest(request: Item): Item {
  return {
    ...request,
    ...(Object.hasOwn(request, "tools") ? { tools: definitions(request["tools"]) } : {}),
    ...(Array.isArray(request["input"]) ? { input: request["input"].map(inputItem) } : {}),
    ...(Object.hasOwn(request, "tool_choice") ? { tool_choice: toolChoice(request["tool_choice"]) } : {}),
  };
}

function outputItem(value: unknown, complete: boolean): unknown {
  const item = object(value);
  if (item?.["type"] !== "function_call" || item["namespace"] !== BRIDGE_NAMESPACE) return value;
  if (!TOOLS.has(String(item["name"]))) throw new NamespaceContractError("invalid_plaintext_call");
  if (!MESSAGE_TOOLS.has(String(item["name"]))) return { ...item, namespace: NATIVE_NAMESPACE };
  let args: Item | undefined;
  try { args = object(JSON.parse(String(item["arguments"]))); } catch { /* Reject truncated JSON. */ }
  const encrypted = item["encrypted_function_args"];
  if ((complete && typeof args?.["message"] !== "string") ||
    (encrypted !== undefined && (!Array.isArray(encrypted) || encrypted.length !== 0))) {
    throw new NamespaceContractError("invalid_plaintext_call");
  }
  // Keep call metadata consistent from added through done. Only a complete,
  // validated done event can become an executable native call.
  // This response belongs to the explicitly unencrypted ordinary-tool contract.
  // Existing native or opaque histories never pass through this marking path.
  return { ...item, namespace: NATIVE_NAMESPACE, encrypted_function_args: [] };
}

export function namespaceEvent(event: Item): Item {
  const response = object(event["response"]);
  return {
    ...event,
    ...(Object.hasOwn(event, "item") ? { item: outputItem(event["item"], event["type"] === "response.output_item.done") } : {}),
    ...(response && Array.isArray(response["output"]) ? { response: {
      ...response, output: response["output"].map((item) => outputItem(item, event["type"] === "response.completed")),
    } } : {}),
  };
}
