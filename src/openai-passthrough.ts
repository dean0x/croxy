import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { CodexIngressConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { SYNTHESIZED_HEADER, SYNTHESIZED_MARKER } from "./errors.js";
import { openaiErrorBody, type CodexEndpointMode } from "./codex-ingress.js";
import { createRawHttpForwarder, filterRawHeaders, setRawRequestHeaders, HOP_BY_HOP, RESPONSE_STRIP, type ForwardedBody } from "./raw-http-passthrough.js";

/** HTTP error response for sockets handed off by Node's upgrade event. */
export const rejectCodexUpgrade = (req: IncomingMessage, socket: Duplex, status: number, message: string): void => {
  if (socket.destroyed) return;
  const response = new http.ServerResponse(req);
  response.assignSocket(req.socket);
  // Manually attached responses do not have http.Server's usual finish handler.
  response.once("finish", () => socket.end());
  socket.resume();
  response.writeHead(status, {
    "content-type": "application/json", connection: "close", [SYNTHESIZED_HEADER]: SYNTHESIZED_MARKER,
  });
  response.end(openaiErrorBody(message));
};

export interface OpenaiPassthrough {
  http(req: IncomingMessage, res: ServerResponse, mode: CodexEndpointMode, path: string, body?: ForwardedBody, rawHeaders?: readonly string[]): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, mode: CodexEndpointMode, path: string, rawHeaders?: readonly string[]): void;
  close(): void;
}

/** Native credentials and payloads come exclusively from the originating Codex client. */
export function createOpenaiPassthrough(config: CodexIngressConfig, logger: Logger): OpenaiPassthrough {
  const targets = {
    subscription: new URL(config.subscriptionBaseUrl),
    api: new URL(config.apiBaseUrl),
  };
  const options = {
    connectTimeoutMs: config.connectTimeoutMs, maxUpstreamSockets: config.maxUpstreamSockets, logger,
    errorBody: openaiErrorBody, logPath: () => "/codex",
    events: { timeout: "openai_upstream_timeout", error: "openai_upstream_error" } as const,
  };
  const forwarders = {
    subscription: createRawHttpForwarder({ ...options, baseUrl: config.subscriptionBaseUrl }),
    api: createRawHttpForwarder({ ...options, baseUrl: config.apiBaseUrl }),
  };
  const sockets = new Set<Duplex>();
  const pending = new Set<http.ClientRequest>();

  return {
    http: (req, res, mode, path, body, headers) => forwarders[mode](req, res, body, path, headers),
    upgrade(req, socket, head, mode, path, rawHeaders) {
      if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") {
        rejectCodexUpgrade(req, socket, 400, "expected a WebSocket upgrade");
        return;
      }
      const target = targets[mode];
      const client = target.protocol === "https:" ? https : http;
      socket.pause();
      sockets.add(socket);
      const upstream = client.request({
        protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ""),
        ...(target.port ? { port: Number(target.port) } : {}),
        method: "GET", path: `${target.pathname.replace(/\/$/, "")}${path}`, agent: false,
      });
      pending.add(upstream);
      let settled = false;
      let tunnel: Duplex | undefined;
      let timer: NodeJS.Timeout | undefined;
      const clearTimer = () => { clearTimeout(timer); timer = undefined; };
      const fail = (status: number, message: string) => {
        if (settled || socket.destroyed) return;
        settled = true;
        clearTimer();
        rejectCodexUpgrade(req, socket, status, message);
        upstream.destroy();
      };
      socket.on("error", () => { upstream.destroy(); tunnel?.destroy(); });
      socket.once("close", () => {
        settled = true;
        clearTimer();
        sockets.delete(socket);
        upstream.destroy();
        tunnel?.destroy();
      });
      upstream.once("close", () => { pending.delete(upstream); clearTimer(); });
      upstream.once("socket", (upstreamSocket) => {
        upstreamSocket.setNoDelay(true);
        // TCP establishment only, matching HTTP passthrough. No handshake/stream deadline.
        if (upstreamSocket.connecting) {
          timer = setTimeout(() => fail(504, "upstream timed out"), config.connectTimeoutMs);
          upstreamSocket.once("connect", clearTimer);
        }
      });
      upstream.once("error", () => fail(502, "upstream connection failed"));
      upstream.once("response", (response) => {
        if (settled || socket.destroyed) { response.destroy(); return; }
        settled = true;
        clearTimer();
        // A rejected upgrade is still an upstream HTTP response. Relay its status,
        // error body and Retry-After through Node so chunk framing remains correct.
        const downstream = new http.ServerResponse(req);
        downstream.assignSocket(req.socket);
        downstream.once("finish", () => socket.end());
        downstream.writeHead(response.statusCode ?? 502, [
          ...filterRawHeaders(response.rawHeaders, RESPONSE_STRIP), "Connection", "close",
        ]);
        response.on("error", () => socket.destroy());
        response.pipe(downstream);
        socket.resume();
      });
      upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
        if (settled || socket.destroyed) { upstreamSocket.destroy(); return; }
        settled = true;
        clearTimer();
        pending.delete(upstream);
        tunnel = upstreamSocket;
        sockets.add(tunnel);
        upstreamSocket.on("error", () => socket.destroy());
        upstreamSocket.once("close", () => { sockets.delete(upstreamSocket); socket.destroy(); });
        const headers = filterRawHeaders(response.rawHeaders, RESPONSE_STRIP);
        let wire = `HTTP/1.1 101 ${response.statusMessage ?? "Switching Protocols"}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`;
        for (let i = 0; i < headers.length; i += 2) wire += `${headers[i]}: ${headers[i + 1]}\r\n`;
        socket.write(`${wire}\r\n`);
        // Preserve bytes already read during both upgrade handshakes before piping.
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        socket.resume();
      });
      setRawRequestHeaders(upstream, filterRawHeaders(rawHeaders ?? req.rawHeaders, HOP_BY_HOP));
      upstream.setHeader("Connection", "Upgrade");
      upstream.setHeader("Upgrade", "websocket");
      upstream.end();
    },
    close() {
      for (const request of pending) request.destroy();
      for (const socket of sockets) socket.destroy();
      forwarders.subscription.close();
      forwarders.api.close();
    },
  };
}
