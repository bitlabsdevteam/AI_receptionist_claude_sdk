/**
 * The little of `ws` that the spike uses. `ws` ships no types, and the spike adds no dependency beyond `ws` itself.
 */
declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { ClientRequest, IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket extends EventEmitter {
    constructor(address: string, options?: { headers?: Record<string, string> });
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "ping" | "pong", listener: (data: Buffer) => void): this;
    on(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { noServer: true });
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
    close(callback?: () => void): void;
  }

  export default WebSocket;
}
