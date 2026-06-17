#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn("npx", ["-y", "@mettamatt/code-reasoning"], {
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);

let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    forwardProtocolLine(line);
  }
});

child.stdout.on("end", () => {
  if (buffer.length > 0) forwardProtocolLine(buffer);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("Failed to start code-reasoning MCP:", error);
  process.exit(1);
});

function forwardProtocolLine(line) {
  if (line.trim().length === 0) return;
  try {
    const message = JSON.parse(line);
    if (message?.method === "notifications/message") {
      console.error(line);
      return;
    }
  } catch {
    console.error(line);
    return;
  }
  process.stdout.write(`${line}\n`);
}
