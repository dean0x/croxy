import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { OpenaiPassthrough } from "./openai-passthrough.js";
import type { CodexNativeAuth } from "./codex-native-auth.js";
import type { CodexEndpointMode } from "./codex-ingress.js";
import type { ClaudeCache } from "./claude-cache.js";
import { filterRawHeaders, HOP_BY_HOP, RESPONSE_STRIP } from "./raw-http-passthrough.js";
import { SYNTHESIZED_HEADER, SYNTHESIZED_MARKER } from "./errors.js";
import { createSseParser, type SseEvent } from "./codex-response.js";
import { createFrameWriter } from "./provider-transport.js";
import { namespaceEvent } from "./collaboration-compat.js";
import { augmentCodexModels } from "./claude-models.js";
import { object } from "./plain-object.js";
import { json } from "./codex-body.js";
import { decodeBody as decode } from "./content-encoding.js";
import { ReverseContractError } from "./claude-errors.js";
import { OPENAI_EVENTS } from "./provider-events.js";

/** Response adaptation is a strategy on the shared raw HTTP transport. */
export class CodexUpstream {
  constructor(
    private readonly options: {
      config: Config;
      logger: Logger;
      raw: OpenaiPassthrough;
      nativeAuth: CodexNativeAuth;
      cache: ClaudeCache;
      closed: () => boolean;
      onError: (res: ServerResponse, error: unknown) => void;
    },
  ) {}
  http(
    req: IncomingMessage,
    res: ServerResponse,
    mode: CodexEndpointMode,
    path: string,
    body: Buffer | undefined,
    transform: Transform,
    rawHeaders: readonly string[],
  ): void {
    if (this.options.closed() || res.destroyed) return;
    this.options.raw.http(
      req,
      res,
      mode,
      path,
      { kind: "complete", bytes: body ?? Buffer.alloc(0) },
      prepareHeaders(rawHeaders, transform, body),
      {
        onUnauthorized: this.options.nativeAuth.canRefresh(req, mode, path)
          ? async () => prepareHeaders(await this.options.nativeAuth.headers(req, mode, path, true), transform, body)
          : undefined,
        onError: (error) => this.options.onError(res, error),
        onResponse: (response) => this.respond(response, res, transform),
      },
    );
  }
  private async respond(response: IncomingMessage, res: ServerResponse, transform: Transform): Promise<void> {
    const status = response.statusCode ?? 502;
    if (transform === "raw" || status < 200 || status >= 300) {
      res.writeHead(status, filterRawHeaders(response.rawHeaders, RESPONSE_STRIP));
      await pipeline(response, res);
      return;
    }
    const headers = [
      ...filterRawHeaders(
        response.rawHeaders,
        new Set([...RESPONSE_STRIP, "content-length", "content-encoding", ...(transform === "models" ? ["etag"] : [])]),
      ),
      SYNTHESIZED_HEADER,
      SYNTHESIZED_MARKER,
    ];
    if (
      transform === "namespace-stream" ||
      (transform === "namespace" && String(response.headers["content-type"]).includes("text/event-stream"))
    )
      await this.stream(response, res, status, headers);
    else await this.buffered(response, res, status, headers, transform === "models");
  }
  private remember(value: unknown): void {
    const response = object(value);
    if (typeof response?.["id"] === "string") this.options.cache.put("adapted", response["id"], true);
  }
  private async stream(
    response: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: string[],
  ): Promise<void> {
    res.writeHead(status, headers);
    const parser = createSseParser(this.options.config.codexIngress.claude.maxSseEventBytes);
    const running = pipeline(response, parser).catch((error) => {
      parser.destroy(error as Error);
    });
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.once("close", onClose);
    const write = createFrameWriter(res, controller.signal);
    try {
      for await (const frame of parser as AsyncIterable<SseEvent>) {
        if (frame.data === "[DONE]") {
          await write("data: [DONE]\n\n");
          continue;
        }
        const event = parseEvent(Buffer.from(frame.data));
        if (event["type"] === "response.completed") {
          this.options.logger.log("info", OPENAI_EVENTS.responseComplete);
          this.remember(event["response"]);
        }
        await write(`data: ${JSON.stringify(event)}\n\n`);
      }
      await running;
      res.end();
    } finally {
      res.off("close", onClose);
      parser.destroy();
      await running;
    }
  }
  private async buffered(
    response: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: string[],
    models: boolean,
  ): Promise<void> {
    const limit = this.options.config.limits.maxBufferedBodyBytes;
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > limit) throw new ReverseContractError("discovery_response_too_large");
      parts.push(chunk);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = json(await decode(Buffer.concat(parts), response.headers["content-encoding"], limit));
    } catch {
      throw new ReverseContractError("invalid_upstream_body");
    }
    const result = models
      ? augmentCodexModels(parsed, this.options.config.codexIngress.claude.aliases)
      : adaptEvent({ type: "response.completed", response: parsed })["response"];
    if (!models) this.remember(result);
    res.writeHead(status, headers);
    res.end(JSON.stringify(result));
  }
}

type Transform = "namespace" | "namespace-stream" | "models" | "raw";
const prepareHeaders = (source: readonly string[], transform: Transform, body?: Buffer): string[] => {
  const strip =
    transform === "raw"
      ? HOP_BY_HOP
      : new Set([
          ...HOP_BY_HOP,
          "content-length",
          "content-encoding",
          "accept-encoding",
          ...(transform === "models" ? ["if-none-match", "if-modified-since"] : []),
        ]);
  const headers = filterRawHeaders(source, body ? new Set([...strip, "content-length"]) : strip);
  if (transform !== "raw") headers.push("accept-encoding", "identity");
  if (body) headers.push("content-length", String(body.length));
  return headers;
};
const parseEvent = (raw: Buffer): Record<string, unknown> => {
  try {
    return adaptEvent(json(raw));
  } catch {
    throw new ReverseContractError("invalid_upstream_body");
  }
};
const adaptEvent = (event: Record<string, unknown>): Record<string, unknown> => {
  try {
    return namespaceEvent(event);
  } catch {
    throw new ReverseContractError("invalid_upstream_body");
  }
};
