import "dotenv/config";
import readline from "node:readline/promises";
import { Agent } from "./agent.js";

const agent = new Agent();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("Sunrise Clinic scheduling assistant (type 'exit' to quit)\n");
console.log("Agent: Hello! I can help you book, reschedule, or cancel an appointment. How can I help?\n");

while (true) {
  const line = (await rl.question("You: ")).trim();
  if (!line || line.toLowerCase() === "exit") break;

  const before = agent.session.log.length;
  let reply: string;
  try {
    reply = await agent.send(line);
  } catch (e: any) {
    // Don't crash the chat on API errors (e.g. quota). Show the message and keep going.
    console.log(`\n[error] ${e.message}\n`);
    continue;
  }

  for (const c of agent.session.log.slice(before)) {
    console.log(`  [tool] ${c.name}(${JSON.stringify(c.args)}) -> ${c.result.ok ? "ok" : (c.result as any).error}`);
  }
  console.log(`\nAgent: ${reply}\n`);
}
rl.close();