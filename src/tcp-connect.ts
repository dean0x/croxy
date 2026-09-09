import type { ClientRequest } from "node:http";

/** ADR-010: bound DNS/TCP establishment only, then disarm before TLS/headers/streaming. */
export const boundTcpConnect = (request: ClientRequest, timeoutMs: number): void => {
  request.once("socket", (socket) => {
    socket.setNoDelay(true);
    if (!socket.connecting) return;
    const clear = () => {
      socket.off("timeout", timeout);
      socket.off("connect", clear);
      request.off("close", clear);
      socket.setTimeout(0);
    };
    const timeout = () => {
      clear();
      // Node suppresses request timeout propagation while socket.connecting is true.
      request.emit("timeout");
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", timeout);
    socket.once("connect", clear);
    request.once("close", clear);
  });
};
