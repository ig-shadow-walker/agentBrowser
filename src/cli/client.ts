import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { PATHS, ensureConfigDir } from "../core/paths.js";
import { createLineReader, writeMessage, type Request, type Response } from "./protocol.js";
import { probe } from "./daemon.js";

/** Talks to the session daemon, starting it on first use. */

let nextId = 1;

async function connect(): Promise<net.Socket> {
  ensureConfigDir();

  if (fs.existsSync(PATHS.daemonSocket)) {
    if (await probe(PATHS.daemonSocket)) {
      return net.connect(PATHS.daemonSocket);
    }
    // Socket file outlived its daemon.
    try { fs.unlinkSync(PATHS.daemonSocket); } catch { /* race with another client */ }
  }

  await spawnDaemon();
  return net.connect(PATHS.daemonSocket);
}

async function spawnDaemon(): Promise<void> {
  const log = fs.openSync(PATHS.daemonLog, "a", 0o600);

  // When compiled to a single binary, argv[1] is not a script we can re-run;
  // the binary itself is the entry point.
  const runningFromScript = process.argv[1]?.endsWith(".js") ?? false;
  const command = process.execPath;
  const args = runningFromScript ? [process.argv[1]!, "__daemon"] : ["__daemon"];

  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();

  // Wait for the daemon to start accepting connections.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(PATHS.daemonSocket) && (await probe(PATHS.daemonSocket))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Session daemon did not start within 20s. See ${PATHS.daemonLog} for details.`);
}

export async function send(request: Omit<Request, "id">): Promise<Response> {
  const socket = await connect();
  const id = nextId++;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.end();
      fn();
    };

    socket.on(
      "data",
      createLineReader<Response>((response) => {
        if (response.id === id) finish(() => resolve(response));
      }),
    );
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Connection to session daemon closed unexpectedly."));
      }
    });

    socket.on("connect", () => writeMessage(socket, { id, ...request }));
    if ((socket as unknown as { connecting: boolean }).connecting === false) {
      writeMessage(socket, { id, ...request });
    }
  });
}

export async function isDaemonRunning(): Promise<boolean> {
  return fs.existsSync(PATHS.daemonSocket) && (await probe(PATHS.daemonSocket));
}
