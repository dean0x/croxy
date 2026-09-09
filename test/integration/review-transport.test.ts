import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { rawHttpRequest, startFakeUpstream, startSubswitch } from "./fake-upstreams.js";

describe("shared transport review controls", () => {
  it("strips Connection-nominated headers in both directions while retaining provider headers", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, ["Connection", "close, X-Origin-Probe", "X-Origin-Probe", "local", "anthropic-beta", "origin-beta"]);
      res.end("unchanged");
    });
    const proxy = await startSubswitch({ anthropic: { baseUrl: upstream.url },
      codexIngress: { enabled: true, apiBaseUrl: upstream.url } });
    try {
      for (const path of ["/v1/messages", "/codex/v1/responses"]) {
        const response = await rawHttpRequest(proxy.url + path, { method: "POST", body: Buffer.from('{"model":"foreign"}'),
          rawHeaders: ["Connection", "keep-alive, X-Relay-Probe", "X-Relay-Probe", "local", "anthropic-beta", "fixture-beta"] });
        assert.equal(response.status, 200); assert.equal(response.body.toString(), "unchanged");
        const headers = response.rawHeaders.map(value => value.toLowerCase());
        assert.ok(!headers.includes("x-origin-probe")); assert.ok(headers.includes("origin-beta"));
      }
      for (const request of upstream.requests) {
        assert.equal(request.headers["x-relay-probe"], undefined);
        assert.equal(request.headers["anthropic-beta"], "fixture-beta");
      }
      assert.equal(upstream.requests.length, 2);
    } finally { await proxy.close(); await upstream.close(); }
  });

  for (const translated of [false, true]) it(`bounds upgraded sockets with Claude routing ${translated ? "enabled" : "disabled"}`, async () => {
    const backend = http.createServer();
    const wss = new WebSocketServer({ server: backend });
    let connections = 0;
    wss.on("connection", () => connections++);
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const upstream = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const proxy = await startSubswitch({ codexIngress: { enabled: true, apiBaseUrl: upstream,
      maxUpstreamSockets: 1, claude: { enabled: translated } } });
    const url = proxy.url.replace("http:", "ws:") + "/codex/v1/responses";
    const first = new WebSocket(url);
    let second: WebSocket | undefined;
    try {
      await once(first, "open");
      second = new WebSocket(url); const secondOpen = once(second, "open");
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(connections, 1, "a pending client must not open another upstream socket");
      first.close(); await secondOpen;
      assert.equal(connections, 2);
    } finally {
      first.terminate(); second?.terminate(); await proxy.close();
      for (const client of wss.clients) client.terminate(); wss.close();
      await new Promise<void>(resolve => backend.close(() => resolve()));
    }
  });
});
