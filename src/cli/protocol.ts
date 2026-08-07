import type { Socket } from "node:net";

/** Newline-delimited JSON over a unix socket. */

export interface Request {
  id: number;
  action?: string;
  args?: Record<string, unknown>;
  control?: "ping" | "shutdown";
}

export interface Response {
  id: number;
  ok: boolean;
  text?: string;
  image?: { base64: string; mimeType: string };
  error?: string;
}

export function writeMessage(socket: Socket, message: Request | Response): void {
  socket.write(JSON.stringify(message) + "\n");
}

/** Buffers partial reads and yields one parsed message per complete line. */
export function createLineReader<T>(onMessage: (message: T) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line) as T);
      } catch {
        /* ignore malformed frame */
      }
    }
  };
}
