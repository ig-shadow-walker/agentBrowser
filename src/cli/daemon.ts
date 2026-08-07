import net from "node:net";
import fs from "node:fs";
import { PATHS, ensureConfigDir } from "../core/paths.js";
import { BrowserSession } from "../core/session.js";
import { runAction } from "../core/actions.js";
import { createLineReader, writeMessage, type Request } from "./protocol.js";

/**
 * Holds one BrowserSession alive between CLI invocations.
 *
 * Without this, every `agentbrowser click …` would launch its own browser and
 * lose the page, making multi-step CLI work impossible. The daemon starts on
 * first use, exits when idle, and is what `agentbrowser close` shuts down.
 */

/** 0 (or less) means never time out — used when running as a login agent. */
const IDLE_TIMEOUT_MS = Number(process.env.AGENTBROWSER_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000);

export async function startDaemon(): Promise<void> {
  ensureConfigDir();

  // Clear a socket left behind by a crashed daemon.
  if (fs.existsSync(PATHS.daemonSocket)) {
    const alive = await probe(PATHS.daemonSocket);
    if (alive) {
      process.stderr.write("agentbrowser daemon already running\n");
      process.exit(0);
    }
    fs.unlinkSync(PATHS.daemonSocket);
  }

  const session = new BrowserSession();
  let idleTimer: NodeJS.Timeout | null = null;

  const shutdown = async (reason: string) => {
    process.stderr.write(`agentbrowser daemon stopping (${reason})\n`);
    if (idleTimer) clearTimeout(idleTimer);
    await session.close().catch(() => {});
    server.close();
    try { fs.unlinkSync(PATHS.daemonSocket); } catch { /* already gone */ }
    try { fs.unlinkSync(PATHS.daemonPid); } catch { /* already gone */ }
    process.exit(0);
  };

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (IDLE_TIMEOUT_MS <= 0) return; // resident: launchd owns the lifetime
    idleTimer = setTimeout(() => void shutdown("idle"), IDLE_TIMEOUT_MS);
    idleTimer.unref();
  };

  const server = net.createServer((socket) => {
    resetIdle();
    socket.on("error", () => {});
    socket.on(
      "data",
      createLineReader<Request>(async (request) => {
        resetIdle();

        if (request.control === "ping") {
          writeMessage(socket, { id: request.id, ok: true, text: "pong" });
          return;
        }
        if (request.control === "shutdown") {
          writeMessage(socket, { id: request.id, ok: true, text: "Session closed." });
          setTimeout(() => void shutdown("requested"), 50);
          return;
        }
        if (!request.action) {
          writeMessage(socket, { id: request.id, ok: false, error: "No action given." });
          return;
        }

        try {
          const result = await runAction(session, request.action, request.args ?? {}, "cli");
          writeMessage(socket, {
            id: request.id,
            ok: true,
            text: result.text,
            ...(result.image ? { image: result.image } : {}),
          });
        } catch (error) {
          writeMessage(socket, {
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PATHS.daemonSocket, () => resolve());
  });

  fs.writeFileSync(PATHS.daemonPid, String(process.pid), { mode: 0o600 });
  fs.chmodSync(PATHS.daemonSocket, 0o600);
  process.stderr.write(`agentbrowser daemon listening on ${PATHS.daemonSocket} (pid ${process.pid})\n`);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  resetIdle();
}

/** Returns true if something is actually accepting connections on the socket. */
export function probe(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}
