import { createSseParser } from "../../src/codex-response.js";
import { namespaceRequest } from "./namespace-adapter.js";
import { claudeToolRequest, openaiSchemaRequest, openaiArgumentsRequest, openaiMarkerRequest, openaiNativeArgumentsRequest, openaiSchemaFieldRequest, TASK } from "./contracts.js";

export type GateProvider = "openai" | "claude";
export type GateAuth = "subscription" | "api";
export type GateStatus = "pass" | "blocked" | "fail";
type ObjectValue = Record<string, unknown>;

export const object = (value: unknown): ObjectValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectValue : undefined;

export interface GateResult {
  readonly gate: string;
  readonly status: GateStatus;
  /** Closed local codes, never an upstream message, prompt, or credential. */
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryAfter?: string;
}

export interface GateReport {
  readonly schemaVersion: 1;
  readonly provider: GateProvider;
  readonly auth: GateAuth;
  readonly results: readonly GateResult[];
}

export interface ProbeOptions {
  readonly provider: GateProvider;
  readonly auth: GateAuth;
  readonly model: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly contract?: "native-history" | "native-arguments" | "schema-fields" | "namespace-control";
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const ERROR_TYPES = new Set([
  "authentication_error", "permission_error", "rate_limit_error", "invalid_request_error",
  "not_found_error", "overloaded_error", "api_error", "insufficient_quota",
]);

/** Retry guidance is retained only if it is an RFC delay or HTTP date. */
const retryAfter = (headers: Headers): { retryAfter?: string } => {
  const value = headers.get("retry-after");
  if (value !== null && (/^\d{1,12}$/.test(value) ||
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))) {
    return { retryAfter: value };
  }
  return {};
};

class ProbeFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) throw new ProbeFailure("missing_body");
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ProbeFailure("response_too_large");
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function responseOutput(raw: Buffer): Promise<ObjectValue> {
  // Require a real terminal event. [DONE], output_item.done, and EOF aren't completion.
  const parser = createSseParser(MAX_RESPONSE_BYTES);
  parser.end(raw);
  let completed: ObjectValue | undefined;
  const items = new Map<number, ObjectValue>();
  for await (const frame of parser) {
    if (frame.data === "[DONE]") continue;
    const event = object(JSON.parse(frame.data));
    if (!event) throw new ProbeFailure("invalid_event");
    if (event["type"] === "response.output_item.done") {
      if (completed) throw new ProbeFailure("output_after_terminal");
      const index = event["output_index"];
      const item = object(event["item"]);
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || !item || items.has(index))
        throw new ProbeFailure("invalid_output_item");
      items.set(index, item);
    }
    if (["error", "response.failed", "response.incomplete"].includes(String(event["type"]))) {
      throw new ProbeFailure("upstream_terminal_failure");
    }
    if (event["type"] === "response.completed") {
      if (completed) throw new ProbeFailure("duplicate_terminal");
      completed = object(event["response"]);
      if (!completed || completed["status"] !== "completed" || !Array.isArray(completed["output"])) {
        throw new ProbeFailure("invalid_terminal");
      }
    }
  }
  if (!completed) throw new ProbeFailure("missing_terminal");
  // Responses-lite can leave terminal output empty; native Codex consumes the
  // preceding output_item.done events. EOF alone still never establishes success.
  if ((completed["output"] as unknown[]).length === 0 && items.size > 0) {
    const output: ObjectValue[] = [];
    for (let index = 0; index < items.size; index++) {
      const item = items.get(index);
      if (!item) throw new ProbeFailure("missing_output_item");
      output.push(item);
    }
    completed = { ...completed, output };
  }
  return completed;
}

interface CallResult { readonly result: GateResult; readonly body?: ObjectValue }

async function call(options: ProbeOptions, gate: string, body: unknown): Promise<CallResult> {
  const endpoint = options.provider === "claude" ? "https://api.anthropic.com/v1/messages" :
    options.auth === "subscription" ? "https://chatgpt.com/backend-api/codex/responses" :
      "https://api.openai.com/v1/responses";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let httpStatus: number | undefined;
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST", headers: options.headers, body: JSON.stringify(body),
      signal: controller.signal, redirect: "error",
    });
    httpStatus = response.status;
    const raw = await boundedBody(response, controller.signal);
    if (!response.ok) {
      let code = "upstream_http_error";
      try {
        const upstream = object(object(JSON.parse(raw.toString("utf8")))?.["error"]);
        const type = upstream?.["type"];
        if (typeof type === "string" && ERROR_TYPES.has(type)) code = type;
        // A generic 429 does not identify exhausted subscription capacity. Only
        // report a spend limit when Anthropic explicitly supplies that signal.
        if (options.provider === "claude" && httpStatus === 429 &&
          object(upstream?.["details"])?.["error_code"] === "enforced_spend_limit_reached") {
          code = "enforced_spend_limit_reached";
        }
        for (const name of ["spawn_agent", "send_message", "followup_task"]) {
          if (upstream?.["param"] === "tools" && upstream["message"] ===
            `Invalid Value: 'tools'. Function 'collaboration.${name}' is reserved for use by this model and must match the configured schema.`) {
            code = `reserved_collaboration_schema_${name}`;
          }
        }
      } catch { /* Never expose an HTML/error body or parser exception. */ }
      return { result: {
        gate, status: [401, 403, 429].includes(httpStatus) || httpStatus >= 500 ? "blocked" : "fail",
        code, httpStatus, ...retryAfter(response.headers),
      } };
    }
    const parsed = options.provider === "openai" ? await responseOutput(raw) : object(JSON.parse(raw.toString("utf8")));
    if (!parsed) throw new ProbeFailure("invalid_response");
    return { result: { gate, status: "pass", code: "accepted", httpStatus }, body: parsed };
  } catch (error) {
    return { result: {
      gate, status: controller.signal.aborted || httpStatus === undefined ? "blocked" : "fail",
      code: controller.signal.aborted ? "request_timeout" : error instanceof ProbeFailure ? error.code :
        httpStatus === undefined ? "network_error" : "invalid_response",
      ...(httpStatus === undefined ? {} : { httpStatus }),
    } };
  } finally { clearTimeout(timer); }
}

const failedContract = (result: GateResult, code: string): GateResult => ({ ...result, status: "fail", code });

async function probeClaude(options: ProbeOptions): Promise<GateResult[]> {
  const request = claudeToolRequest(options.model);
  const first = await call(options, "claude_tool_call", request);
  if (!first.body) return [first.result];
  const content = first.body["content"];
  const calls = Array.isArray(content) ? content.map(object).filter((item) => item?.["type"] === "tool_use") : [];
  const tool = calls[0];
  if (first.body["stop_reason"] !== "tool_use" || calls.length !== 1 || !tool ||
    typeof tool["id"] !== "string" || !tool["id"] || tool["name"] !== "echo" ||
    object(tool["input"])?.["text"] !== "gate-ok") {
    return [failedContract(first.result, "unexpected_tool_call")];
  }
  const next = await call(options, "claude_tool_continuation", {
    ...request, tool_choice: { type: "none" },
    messages: [
      ...request.messages,
      // Replay ALL blocks verbatim, including thinking/signature/redacted state.
      { role: "assistant", content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: tool["id"], content: "gate-ok" }] },
    ],
  });
  const final = next.body;
  const hasText = Array.isArray(final?.["content"]) && final["content"].some((item: unknown) =>
    object(item)?.["type"] === "text" && typeof object(item)?.["text"] === "string" &&
    (object(item)?.["text"] as string).includes("gate-ok"));
  return [first.result, final && (final["stop_reason"] !== "end_turn" || !hasText) ?
    failedContract(next.result, "invalid_continuation") : next.result];
}

async function probeOpenai(options: ProbeOptions): Promise<GateResult[]> {
  const control = await call(options, "openai_native_schema_control", openaiSchemaRequest(options.model, false));
  if (!control.body) return [control.result];
  if (options.contract === "namespace-control") {
    // A diagnostic control, not production namespace rewriting. This distinguishes
    // general schema support from the backend's reserved collaboration contract.
    const request = openaiSchemaRequest(options.model);
    request.input[0]!.tools![0]!.name = "subswitch_collaboration";
    const schema = await call(options, "openai_ordinary_namespace_schema", request);
    if (!schema.body) return [control.result, schema.result];
    request.input[1] = { type: "message", role: "user", content: [{ type: "input_text", text:
      `Call subswitch_collaboration.spawn_agent once with task_name probe, model claude-sonnet-5, fork_turns none, and message exactly ${JSON.stringify(TASK)}.` }] };
    const generated = await call(options, "openai_ordinary_namespace_arguments", request);
    if (!generated.body) return [control.result, schema.result, generated.result];
    const calls = (generated.body["output"] as unknown[]).map(object).filter((item) => item?.["type"] === "function_call");
    let plaintext = false;
    try {
      const tool = calls[0];
      const args = object(JSON.parse(String(tool?.["arguments"])));
      plaintext = calls.length === 1 && tool?.["namespace"] === "subswitch_collaboration" && tool["name"] === "spawn_agent" &&
        args?.["message"] === TASK && args["model"] === "claude-sonnet-5";
    } catch { /* Never relabel or decrypt opaque payloads. */ }
    if (!plaintext) return [control.result, schema.result, failedContract(generated.result, "plaintext_arguments_not_observed")];
    const history = await call(options, "openai_ordinary_namespace_history", namespaceRequest(openaiMarkerRequest(options.model, false)));
    return [control.result, schema.result, generated.result, history.result];
  }
  if (options.contract === "schema-fields") {
    const results = [control.result];
    for (const name of ["spawn_agent", "send_message", "followup_task"] as const) {
      for (const mode of ["false", "omit"] as const) {
        const variant = await call(options, `openai_schema_${name}_${mode}`, openaiSchemaFieldRequest(options.model, name, mode));
        results.push(variant.result);
        // Independent schema comparisons are not inference retries or fallbacks.
        // Stop the matrix on auth, transport, or availability failures.
        if (variant.result.status === "blocked") return results;
      }
    }
    return results;
  }
  if (options.contract === "native-history") {
    const history = await call(options, "openai_native_plaintext_history", openaiMarkerRequest(options.model, false));
    return [control.result, history.result];
  }
  if (options.contract === "native-arguments") {
    const generated = await call(options, "openai_native_sonnet_arguments", openaiNativeArgumentsRequest(options.model));
    if (!generated.body) return [control.result, generated.result];
    const calls = (generated.body["output"] as unknown[]).map(object).filter((item) => item?.["type"] === "function_call");
    let plaintext = false;
    try {
      const tool = calls[0];
      const args = object(JSON.parse(String(tool?.["arguments"])));
      plaintext = calls.length === 1 && tool?.["namespace"] === "collaboration" && tool["name"] === "spawn_agent" &&
        args?.["message"] === TASK && args["model"] === "claude-sonnet-5";
    } catch { /* No ciphertext decoding or relabeling. */ }
    return [control.result, plaintext ? generated.result : failedContract(generated.result, "native_plaintext_arguments_not_observed")];
  }
  const first = await call(options, "openai_plaintext_schema", openaiSchemaRequest(options.model));
  if (!first.body) return [control.result, first.result];
  const argumentsResult = await call(options, "openai_plaintext_arguments", openaiArgumentsRequest(options.model));
  const prefix = [control.result, first.result];
  if (!argumentsResult.body) return [...prefix, argumentsResult.result];
  const calls = (argumentsResult.body["output"] as unknown[]).map(object).filter((item) => item?.["type"] === "function_call");
  let valid = false;
  try {
    const tool = calls[0];
    const args = object(JSON.parse(String(tool?.["arguments"])));
    valid = calls.length === 1 && tool?.["namespace"] === "collaboration" && tool["name"] === "spawn_agent" &&
      args?.["task_name"] === "probe" && args["message"] === TASK;
  } catch { /* Ciphertext and invalid/truncated JSON never become executable calls. */ }
  if (!valid) return [...prefix, failedContract(argumentsResult.result, "plaintext_arguments_not_observed")];
  // This is deliberately a fabricated history, not ciphertext relabeled as plaintext.
  const second = await call(options, "openai_plaintext_markers", openaiMarkerRequest(options.model));
  return [...prefix, argumentsResult.result, second.result];
}

/** No retries, mode fallback, tool execution, credential writes, or client configuration changes. */
export async function runProbe(options: ProbeOptions): Promise<GateReport> {
  return {
    schemaVersion: 1, provider: options.provider, auth: options.auth,
    results: await (options.provider === "claude" ? probeClaude(options) : probeOpenai(options)),
  };
}

export const reportExitCode = (report: GateReport): number =>
  report.results.length === 0 || report.results.some((result) => result.status === "fail") ? 1 :
    report.results.some((result) => result.status === "blocked") ? 2 : 0;
