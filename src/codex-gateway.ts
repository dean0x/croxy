import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID, createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { createOpenaiPassthrough, rejectCodexUpgrade, type OpenaiPassthrough } from "./openai-passthrough.js";
import { filterRawHeaders, setRawRequestHeaders, HOP_BY_HOP, RESPONSE_STRIP, type ForwardedBody } from "./raw-http-passthrough.js";
import { sniffLeadingModel, MODEL_SNIFF_BYTES } from "./anthropic-parse.js";
import { namespaceRequest, namespaceEvent } from "./collaboration-compat.js";
import { claudeResolver, augmentCodexModels } from "./claude-models.js";
import { object } from "./claude-contract.js";
import { ClaudeAuthManager, createClaudeCredentialStore, type ClaudeAuth } from "./claude-auth.js";
import { ClaudeHandler, ClaudeHttpError } from "./claude-handler.js";
import { reverseEvents, ReverseContractError, type Item } from "./claude-adapter.js";
import { ReasoningCache } from "./reasoning-cache.js";
import { createSseParser, type SseEvent } from "./codex-response.js";
import { createFrameWriter, drainRejectedUpload } from "./provider-transport.js";
import { SYNTHESIZED_HEADER, SYNTHESIZED_MARKER } from "./errors.js";
import type { CodexEndpointMode } from "./codex-ingress.js";
import type { ProviderAuth } from "./provider-auth.js";

const decode = (raw: Buffer, encoding: string | string[] | undefined, limit: number): Buffer => {
  if (!encoding || encoding === "identity") return raw;
  const codecs: Record<string, (data: Buffer, options: { maxOutputLength: number }) => Buffer> = {
    gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, deflate: zlib.inflateSync, zstd: zlib.zstdDecompressSync,
  };
  const codec = typeof encoding === "string" ? codecs[encoding] : undefined;
  if (!codec) throw new ReverseContractError("unsupported_content_encoding");
  try { return codec(raw, { maxOutputLength: limit }); } catch { throw new ReverseContractError("invalid_or_oversized_compressed_body"); }
};
const json = (raw: Buffer): Item => { try { return object(JSON.parse(raw.toString("utf8"))) ?? invalid(); } catch { return invalid(); } };
function invalid(): never { throw new ReverseContractError("invalid_json_body"); }
const inputItems = (input: unknown): Item[] => Array.isArray(input) ? input as Item[] :
  typeof input === "string" ? [{ type: "message", role: "user", content: input }] : [];
interface Snapshot { request: Item; input: Item[] }

/** Reverse-enabled ingress: raw same-provider forwarding, scoped collaboration adaptation, Claude dispatch. */
export class CodexGateway implements OpenaiPassthrough {
  private readonly raw: OpenaiPassthrough;
  private readonly claude: ClaudeHandler;
  private readonly resolve: (model: string) => string | undefined;
  private readonly cache: ReasoningCache;
  private readonly adaptedResponses: ReasoningCache;
  private readonly wss: WebSocketServer;
  private readonly upstreamSockets = new Set<WebSocket>();
  private readonly requests = new Set<http.ClientRequest>();
  private readonly controllers = new Set<AbortController>();
  private readonly pendingUpgrades = new Set<Duplex>();
  private closed = false;
  private readonly streams = new WeakMap<ServerResponse, { id: string; model: string; sequence: number }>();
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  constructor(private readonly config: Config, private readonly logger: Logger, auth?: ClaudeAuth, fetchImpl?: typeof fetch,
    private readonly parentAuth?: ProviderAuth<"codex">) {
    const provider = config.codexIngress.claude;
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: config.codexIngress.maxUpstreamSockets });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: config.codexIngress.maxUpstreamSockets });
    this.raw = createOpenaiPassthrough(config.codexIngress, logger);
    this.resolve = claudeResolver(provider.aliases);
    this.cache = new ReasoningCache(provider.continuationCache.maxEntries, provider.continuationCache.maxBytes);
    this.adaptedResponses = new ReasoningCache(provider.continuationCache.maxEntries, provider.continuationCache.maxBytes);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxBufferedBodyBytes });
    this.claude = new ClaudeHandler(provider, auth ?? new ClaudeAuthManager({
      store: createClaudeCredentialStore(provider), oauthTokenUrl: provider.oauthTokenUrl, logger,
    }), logger, fetchImpl);
  }
  close(): void {
    this.closed = true;
    for (const socket of this.pendingUpgrades) socket.destroy();
    for (const controller of this.controllers) controller.abort();
    for (const request of this.requests) request.destroy();
    for (const ws of this.wss.clients) ws.terminate();
    for (const ws of this.upstreamSockets) ws.terminate();
    this.wss.close(); this.raw.close(); this.httpAgent.destroy(); this.httpsAgent.destroy();
  }
  http(req: IncomingMessage, res: ServerResponse, mode: CodexEndpointMode, path: string): void {
    if (this.closed) { this.httpError(res, new ClaudeHttpError(503, "SubSwitch is shutting down.", "proxy_closing")); return; }
    void this.handleHttp(req, res, mode, path).catch(error => this.httpError(res, error));
  }
  private failure(error: unknown) {
    if (error instanceof ClaudeHttpError) return { status: error.status, message: error.message, code: error.code, retryAfter: error.retryAfter };
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return { status: 504, message: "OpenAI connection timed out.", code: "openai_timeout", retryAfter: undefined };
    const code = error instanceof ReverseContractError ? error.code : "upstream_connection_failed";
    const status = code.includes("state") ? 409 : code.includes("oversized") || code.includes("too_large") ? 413 :
      /^(upstream_|invalid_claude|missing_claude|claude_stream|unterminated_claude)/.test(code) ? 502 : 400;
    return { status, code, message: `SubSwitch could not translate this request (${code}).`, retryAfter: undefined };
  }
  private httpError(res: ServerResponse, error: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    const failure = this.failure(error);
    this.logger.log("warn", "claude_request_failed", { status: failure.status, errorCode: failure.code });
    if (res.headersSent) {
      const stream = this.streams.get(res);
      res.end(`data: ${JSON.stringify({ type: "response.failed", sequence_number: (stream?.sequence ?? 0) + 1,
        response: { id: stream?.id ?? `resp_subswitch_${randomUUID()}`, object: "response", model: stream?.model ?? "", created_at: Math.floor(Date.now() / 1000),
          status: "failed", output: [], error: { code: failure.code, message: failure.message } } })}\n\n`);
      this.streams.delete(res);
    } else {
      res.writeHead(failure.status, { "content-type": "application/json", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER,
        ...(failure.retryAfter ? { "retry-after": failure.retryAfter } : {}) });
      res.end(JSON.stringify({ error: { type: "api_error", code: failure.code, message: failure.message } }));
    }
  }
  private async readBody(req: IncomingMessage): Promise<ForwardedBody> {
    const parts: Buffer[] = []; let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      parts.push(chunk);
      if (bytes > this.config.limits.maxBufferedBodyBytes) return { kind: "prefix", bytes: Buffer.concat(parts) };
    }
    return { kind: "complete", bytes: Buffer.concat(parts) };
  }
  private async nativeHeaders(req: IncomingMessage, mode: CodexEndpointMode): Promise<readonly string[]> {
    if (this.closed) throw new ClaudeHttpError(503, "SubSwitch is shutting down.", "proxy_closing");
    if (mode !== "subscription" || req.headers.authorization !== undefined || typeof req.headers["chatgpt-account-id"] !== "string" || !this.parentAuth) return req.rawHeaders;
    const credentials = await this.parentAuth.getCredentials();
    if (this.closed) throw new ClaudeHttpError(503, "SubSwitch is shutting down.", "proxy_closing");
    if (!credentials.ok) throw new ClaudeHttpError(401, credentials.error.message, "codex_auth_unavailable");
    if (credentials.value.authHeaders["chatgpt-account-id"] !== req.headers["chatgpt-account-id"])
      throw new ClaudeHttpError(401, "Native Codex account does not match the configured Codex credential store.", "codex_account_mismatch");
    return [...req.rawHeaders, "authorization", credentials.value.authHeaders["authorization"]!];
  }
  private canRefreshNative(req: IncomingMessage, mode: CodexEndpointMode): boolean {
    return mode === "subscription" && req.headers.authorization === undefined && typeof req.headers["chatgpt-account-id"] === "string" && this.parentAuth !== undefined;
  }
  private async refreshNativeHeaders(req: IncomingMessage): Promise<readonly string[]> {
    const credentials = await this.parentAuth!.forceRefresh();
    if (!credentials.ok) throw new ClaudeHttpError(401, credentials.error.message, "codex_auth_unavailable");
    if (credentials.value.authHeaders["chatgpt-account-id"] !== req.headers["chatgpt-account-id"])
      throw new ClaudeHttpError(401, "Native Codex account does not match the configured Codex credential store.", "codex_account_mismatch");
    return [...req.rawHeaders, "authorization", credentials.value.authHeaders["authorization"]!];
  }
  private fullRequest(body: Item, model: string): Item {
    const previous = body["previous_response_id"];
    if (previous !== undefined && previous !== null && typeof previous !== "string") throw new ReverseContractError("invalid_previous_response_id");
    let snapshot: Snapshot | undefined;
    if (typeof previous === "string") {
      snapshot = this.cache.get(previous)?.[0] as Snapshot | undefined;
      if (!snapshot) throw new ReverseContractError("missing_continuation_state");
      if (snapshot.request["model"] !== model) throw new ReverseContractError("cross_provider_state_unavailable");
    }
    const full: Item = { ...snapshot?.request, ...body, model, input: [...snapshot?.input ?? [], ...inputItems(body["input"])] };
    delete full["previous_response_id"];
    if (body["generate"] !== false) delete full["generate"];
    return full;
  }
  private destination(body: Item): string | undefined {
    if (typeof body["model"] === "string") return this.resolve(body["model"]);
    if (typeof body["previous_response_id"] === "string") {
      const snapshot = this.cache.get(body["previous_response_id"])?.[0] as Snapshot | undefined;
      if (typeof snapshot?.request["model"] === "string") return this.resolve(snapshot.request["model"]);
    }
    return undefined;
  }
  private correlation(req: IncomingMessage): string | undefined {
    const value = req.headers["thread-id"] ?? req.headers["session-id"];
    return typeof value === "string" && value.length <= 1024 ? createHash("sha256").update(value).digest("hex").slice(0, 8) : undefined;
  }
  private async *claudeEvents(body: Item, model: string, signal: AbortSignal, sessionKey?: string): AsyncGenerator<Item> {
    const full = this.fullRequest(body, model);
    if (body["generate"] === false) {
      const id = `resp_subswitch_${randomUUID()}`;
      this.cache.put(id, [{ request: full, input: inputItems(full["input"]) } satisfies Snapshot]);
      yield* reverseEvents(id, model, []); return;
    }
    if (inputItems(body["input"]).some(entry => ["function_call_output", "custom_tool_call_output"].includes(String(entry["type"]))))
      this.logger.log("info", "claude_tool_result", { model });
    for await (const event of this.claude.respond(full, signal, sessionKey)) {
      if (event["type"] === "response.completed") {
        const response = object(event["response"]);
        if (typeof response?.["id"] === "string" && Array.isArray(response["output"]))
          this.cache.put(response["id"], [{ request: full, input: [...inputItems(full["input"]), ...response["output"] as Item[]] } satisfies Snapshot]);
      }
      yield event;
    }
  }
  private parentRequest(body: Item): Item {
    if (typeof body["previous_response_id"] === "string" && body["previous_response_id"].startsWith("resp_subswitch_"))
      throw new ReverseContractError("cross_provider_state_unavailable");
    return namespaceRequest(body);
  }
  private async handleHttp(req: IncomingMessage, res: ServerResponse, mode: CodexEndpointMode, path: string): Promise<void> {
    if (!this.config.codexIngress.claude.enabled) { this.raw.http(req, res, mode, path, undefined, await this.nativeHeaders(req, mode)); return; }
    const pathname = path.split("?")[0];
    if (req.method === "GET" && pathname === "/models") { await this.openaiHttp(req, res, mode, path, undefined, "models", await this.nativeHeaders(req, mode)); return; }
    if (req.method !== "POST" || (pathname !== "/responses" && pathname !== "/responses/compact")) { this.raw.http(req, res, mode, path, undefined, await this.nativeHeaders(req, mode)); return; }
    const consumed = await this.readBody(req);
    if (this.closed) throw new ClaudeHttpError(503, "SubSwitch is shutting down.", "proxy_closing");
    const raw = consumed.bytes;
    if (consumed.kind === "prefix") {
      const name = sniffLeadingModel(raw.subarray(0, MODEL_SNIFF_BYTES));
      if (name && this.resolve(name)) { drainRejectedUpload(req); throw new ReverseContractError("request_too_large"); }
      const headers = await this.nativeHeaders(req, mode);
      this.logger.log("warn", "codex_compat_over_window_passthrough", { bodyMode: "streamed" });
      this.raw.http(req, res, mode, path, req.readableEnded ? { kind: "complete", bytes: raw } : consumed, headers);
      return;
    }
    let body: Item;
    try { body = json(decode(raw, req.headers["content-encoding"], this.config.limits.maxBufferedBodyBytes)); }
    catch {
      // An uninspectable request remains the original provider's responsibility.
      this.raw.http(req, res, mode, path, { kind: "complete", bytes: raw }, await this.nativeHeaders(req, mode)); return;
    }
    const model = this.destination(body);
    if (!model) {
      const nativeHeaders = await this.nativeHeaders(req, mode);
      if (pathname === "/responses/compact") {
        if (this.canRefreshNative(req, mode)) await this.openaiHttp(req, res, mode, path, raw, "raw", nativeHeaders);
        else this.raw.http(req, res, mode, path, { kind: "complete", bytes: raw }, nativeHeaders);
        return;
      }
      const mapped = this.parentRequest(body);
      const continuationAdapted = typeof body["previous_response_id"] === "string" && !!this.adaptedResponses.get(body["previous_response_id"]);
      if (!continuationAdapted && JSON.stringify(mapped) === JSON.stringify(body)) {
        if (this.canRefreshNative(req, mode)) await this.openaiHttp(req, res, mode, path, raw, "raw", nativeHeaders);
        else this.raw.http(req, res, mode, path, { kind: "complete", bytes: raw }, nativeHeaders);
      }
      else await this.openaiHttp(req, res, mode, path, Buffer.from(JSON.stringify(mapped)), body["stream"] === true ? "namespace-stream" : "namespace", nativeHeaders);
      return;
    }
    if (pathname === "/responses/compact") throw new ReverseContractError("translated_compaction_unavailable");
    const controller = new AbortController(); this.controllers.add(controller);
    const close = () => { if (!res.writableFinished) controller.abort(); };
    res.on("close", close);
    const write = createFrameWriter(res, controller.signal);
    let result: unknown;
    let ping: ReturnType<typeof setInterval> | undefined;
    try {
      for await (const event of this.claudeEvents(body, model, controller.signal, this.correlation(req))) {
        if (body["stream"] === true) {
          const response = object(event["response"]);
          const previous = this.streams.get(res);
          this.streams.set(res, { id: typeof response?.["id"] === "string" ? response["id"] : previous?.id ?? "",
            model, sequence: typeof event["sequence_number"] === "number" ? event["sequence_number"] : previous?.sequence ?? 0 });
          if (!res.headersSent) {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER });
            ping = setInterval(() => { if (!res.destroyed && res.writableLength < 65536) res.write(": ping\n\n"); }, this.config.limits.pingIntervalMs);
          }
          await write(`data: ${JSON.stringify(event)}\n\n`);
        } else if (event["type"] === "response.completed" || event["type"] === "response.incomplete") result = event["response"];
      }
      if (body["stream"] !== true) { res.writeHead(200, { "content-type": "application/json", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER }); res.end(JSON.stringify(result)); }
      else res.end();
    } finally { clearInterval(ping); res.off("close", close); this.controllers.delete(controller); if (res.writableEnded || res.destroyed) this.streams.delete(res); }
  }
  private target(mode: CodexEndpointMode, path: string): URL {
    return new URL(`${(mode === "subscription" ? this.config.codexIngress.subscriptionBaseUrl : this.config.codexIngress.apiBaseUrl).replace(/\/$/, "")}${path}`);
  }
  private boundConnect(request: http.ClientRequest): void {
    request.once("socket", socket => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => request.destroy(Object.assign(new Error("OpenAI connection timed out"), { code: "ETIMEDOUT" })), this.config.codexIngress.connectTimeoutMs);
      socket.once("connect", () => clearTimeout(timer)); socket.once("close", () => clearTimeout(timer)); request.once("close", () => clearTimeout(timer));
    });
  }
  private async openaiHttp(req: IncomingMessage, res: ServerResponse, mode: CodexEndpointMode, path: string,
    body: Buffer | undefined, transform: "namespace" | "namespace-stream" | "models" | "raw", rawHeaders: readonly string[]): Promise<void> {
    if (this.closed || res.destroyed) return;
    const target = this.target(mode, path);
    let outgoing: http.ClientRequest | undefined;
    let currentHeaders = rawHeaders;
    const close = () => { if (!res.writableFinished) outgoing?.destroy(); }; res.on("close", close);
    try {
      let response: IncomingMessage | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.closed || res.destroyed) return;
        const request = (target.protocol === "https:" ? https : http).request(target, { method: req.method, agent: target.protocol === "https:" ? this.httpsAgent : this.httpAgent });
        outgoing = request; this.requests.add(request); request.once("close", () => this.requests.delete(request));
        const headers = filterRawHeaders(currentHeaders, transform === "raw" ? HOP_BY_HOP : new Set([...HOP_BY_HOP, "content-length", "content-encoding", "accept-encoding",
          ...(transform === "models" ? ["if-none-match", "if-modified-since"] : [])]));
        setRawRequestHeaders(request, headers);
        if (transform !== "raw") request.setHeader("accept-encoding", "identity");
        if (body) request.setHeader("content-length", body.length);
        this.boundConnect(request);
        response = await new Promise<IncomingMessage>((resolve, reject) => { request.once("response", resolve); request.once("error", reject); request.end(body); });
        if (response.statusCode !== 401 || attempt === 1 || !this.canRefreshNative(req, mode)) break;
        response.destroy(); request.destroy(); currentHeaders = await this.refreshNativeHeaders(req);
        if (res.destroyed) return;
      }
      if (!response) throw new ReverseContractError("upstream_response_missing");
      const status = response.statusCode ?? 502;
      if (transform === "raw" || status < 200 || status >= 300) {
        res.writeHead(status, filterRawHeaders(response.rawHeaders, RESPONSE_STRIP)); await pipeline(response, res); return;
      }
      const responseHeaders = [...filterRawHeaders(response.rawHeaders, new Set([...RESPONSE_STRIP, "content-length", "content-encoding", ...(transform === "models" ? ["etag"] : [])])), SYNTHESIZED_HEADER, SYNTHESIZED_MARKER];
      if (transform === "namespace-stream" || (transform === "namespace" && String(response.headers["content-type"]).includes("text/event-stream"))) {
        res.writeHead(status, responseHeaders);
        const parser = createSseParser(this.config.codexIngress.claude.maxSseEventBytes);
        const running = pipeline(response, parser).catch(error => { parser.destroy(error as Error); });
        const controller = new AbortController(); const onClose = () => controller.abort(); res.once("close", onClose);
        const write = createFrameWriter(res, controller.signal);
        try {
          for await (const frame of parser as AsyncIterable<SseEvent>) {
            if (frame.data === "[DONE]") { await write("data: [DONE]\n\n"); continue; }
            const event = namespaceEvent(json(Buffer.from(frame.data)));
            if (event["type"] === "response.completed") {
              this.logger.log("info", "codex_response_complete");
              const response = object(event["response"]);
              if (typeof response?.["id"] === "string") this.adaptedResponses.put(response["id"], [true]);
            }
            await write(`data: ${JSON.stringify(event)}\n\n`);
          }
          await running; res.end();
        } finally { res.off("close", onClose); parser.destroy(); await running; }
      } else {
        const parts: Buffer[] = []; let size = 0;
        for await (const chunk of response) { size += chunk.length; if (size > this.config.limits.maxBufferedBodyBytes) throw new ReverseContractError("discovery_response_too_large"); parts.push(chunk); }
        const parsed = json(decode(Buffer.concat(parts), response.headers["content-encoding"], this.config.limits.maxBufferedBodyBytes));
        const result = transform === "models" ? augmentCodexModels(parsed, this.config.codexIngress.claude.aliases) : namespaceEvent({ type: "response.completed", response: parsed })["response"];
        if (transform !== "models" && typeof object(result)?.["id"] === "string") this.adaptedResponses.put(object(result)!["id"] as string, [true]);
        res.writeHead(status, responseHeaders); res.end(JSON.stringify(result));
      }
    } finally { res.off("close", close); if (outgoing) { this.requests.delete(outgoing); outgoing.destroy(); } }
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, mode: CodexEndpointMode, path: string): void {
    if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") { rejectCodexUpgrade(req, socket, 400, "expected a WebSocket upgrade"); return; }
    socket.pause(); this.pendingUpgrades.add(socket); socket.once("close", () => this.pendingUpgrades.delete(socket));
    void this.nativeHeaders(req, mode).then(headers => {
      if (!this.closed && !socket.destroyed) this.upgradeReady(req, socket, head, mode, path, headers);
    }).catch(error => { const failure = this.failure(error); rejectCodexUpgrade(req, socket, failure.status, failure.message); });
  }
  private upgradeReady(req: IncomingMessage, socket: Duplex, head: Buffer, mode: CodexEndpointMode, path: string, nativeHeaders: readonly string[], refreshed = false): void {
    if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") { rejectCodexUpgrade(req, socket, 400, "expected a WebSocket upgrade"); return; }
    if (!this.config.codexIngress.claude.enabled || path.split("?")[0] !== "/responses") { this.pendingUpgrades.delete(socket); this.raw.upgrade(req, socket, head, mode, path, nativeHeaders); return; }
    const target = this.target(mode, path); target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const flat = filterRawHeaders(nativeHeaders, new Set([...HOP_BY_HOP, "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]));
    const headers: Record<string, string> = {};
    for (let index = 0; index < flat.length; index += 2) headers[flat[index]!] = flat[index + 1]!;
    const protocols = typeof req.headers["sec-websocket-protocol"] === "string" ? req.headers["sec-websocket-protocol"].split(",").map(value => value.trim()) : [];
    let upstream: WebSocket;
    try { upstream = new WebSocket(target, protocols, { headers, maxPayload: this.config.limits.maxBufferedBodyBytes,
      finishRequest: request => { this.boundConnect(request); request.end(); } }); }
    catch { rejectCodexUpgrade(req, socket, 400, "invalid WebSocket handshake"); return; }
    this.upstreamSockets.add(upstream);
    let accepted = false;
    const earlyClose = () => upstream.terminate(); socket.once("close", earlyClose);
    upstream.once("unexpected-response", (_request, response) => {
      accepted = true; // HTTP rejection owns the socket; do not assign a second response on close/error.
      if (response.statusCode === 401 && !refreshed && this.canRefreshNative(req, mode)) {
        response.destroy(); upstream.terminate();
        void this.refreshNativeHeaders(req).then(headers => { if (!this.closed && !socket.destroyed) this.upgradeReady(req, socket, head, mode, path, headers, true); })
          .catch(error => { const failure = this.failure(error); rejectCodexUpgrade(req, socket, failure.status, failure.message); });
        return;
      }
      this.logger.log("warn", "openai_websocket_rejected", { status: response.statusCode ?? 502 });
      const local = new http.ServerResponse(req); local.assignSocket(req.socket);
      socket.resume();
      local.once("finish", () => socket.end());
      local.writeHead(response.statusCode ?? 502, filterRawHeaders(response.rawHeaders, RESPONSE_STRIP)); response.pipe(local);
      response.once("end", () => upstream.terminate());
    });
    upstream.once("error", error => { if (!accepted) rejectCodexUpgrade(req, socket, (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? 504 : 502, "OpenAI WebSocket connection failed"); });
    upstream.once("close", () => this.upstreamSockets.delete(upstream));
    upstream.once("open", () => {
      if (socket.destroyed) { upstream.terminate(); return; }
      this.wss.handleUpgrade(req, socket, head, client => {
        this.pendingUpgrades.delete(socket);
        accepted = true; socket.off("close", earlyClose);
        const active = new Map<string, AbortController>();
        let forwardedOpenai = false;
        const send = (event: Item): Promise<void> => new Promise((resolve, reject) => {
          if (client.readyState !== WebSocket.OPEN) { resolve(); return; }
          client.send(JSON.stringify(event), error => error ? reject(error) : resolve());
        });
        const failure = (error: unknown, streamId?: string) => {
          const result = this.failure(error);
          void send({ type: "error", code: result.code, status: result.status,
            message: result.retryAfter ? `${result.message} (Retry-After: ${result.retryAfter})` : result.message,
            ...(result.retryAfter ? { retry_after: result.retryAfter } : {}), ...(streamId ? { stream_id: streamId } : {}) }).catch(() => undefined);
        };
        client.on("error", () => undefined);
        client.once("close", () => { for (const controller of active.values()) controller.abort(); upstream.terminate(); });
        upstream.on("error", () => { if (forwardedOpenai && client.readyState === WebSocket.OPEN) client.close(1011, "OpenAI connection failed"); });
        upstream.once("close", () => { if (forwardedOpenai && client.readyState === WebSocket.OPEN) client.close(); });
        let responseQueue = Promise.resolve();
        upstream.on("message", data => {
          upstream.pause();
          responseQueue = responseQueue.then(async () => {
            const event = namespaceEvent(json(Buffer.from(data.toString())));
            if (event["type"] === "response.completed") this.logger.log("info", "codex_response_complete");
            await send(event);
          })
            .catch(error => failure(error)).finally(() => { if (upstream.readyState === WebSocket.OPEN) upstream.resume(); });
        });
        client.on("message", data => {
          if (this.closed || client.readyState !== WebSocket.OPEN) return;
          let body: Item;
          try { body = json(Buffer.from(data.toString())); } catch (error) { failure(error); return; }
          const streamId = typeof body["stream_id"] === "string" ? body["stream_id"] : undefined;
          if (body["type"] === "response.cancel") {
            const target = typeof body["response_id"] === "string" ? body["response_id"] : streamId ?? "default";
            const controller = active.get(target);
            if (controller) { controller.abort(); return; }
            if (target.startsWith("resp_subswitch_")) return;
          }
          const model = this.destination(body);
          if (!model) {
            if (upstream.readyState !== WebSocket.OPEN) { client.close(1012, "Reconnect OpenAI stream"); return; }
            try { forwardedOpenai = true; upstream.send(JSON.stringify(this.parentRequest(body))); } catch (error) { failure(error, streamId); } return;
          }
          const key = streamId ?? "default";
          if (active.has(key)) { failure(new ReverseContractError("concurrent_claude_stream_id"), streamId); return; }
          const controller = new AbortController(); active.set(key, controller); this.controllers.add(controller);
          void (async () => {
            try {
              for await (const event of this.claudeEvents(body, model, controller.signal, this.correlation(req))) {
                const response = object(event["response"]);
                if (typeof response?.["id"] === "string") active.set(response["id"], controller);
                await send({ ...event, ...(streamId ? { stream_id: streamId } : {}) });
              }
            } catch (error) { if (!controller.signal.aborted) failure(error, streamId); }
            finally { for (const [name, candidate] of active) if (candidate === controller) active.delete(name); this.controllers.delete(controller); }
          })();
        });
        socket.resume();
      });
    });
  }
}
