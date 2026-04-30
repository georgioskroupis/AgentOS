#!/usr/bin/env node
import readline from "node:readline";

if (process.argv.includes("--help")) {
  console.log("fake app-server JSON-RPC");
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } });
  } else if (message.method === "thread/start") {
    write({ id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "turn/start") {
    write({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    const complete = () => {
      write({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" }
        }
      });
    };
    if (process.argv.includes("--instant")) complete();
    else setTimeout(complete, 10);
  } else if (message.method === "turn/interrupt") {
    write({ id: message.id, result: {} });
  }
});
