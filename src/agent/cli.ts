import "dotenv/config";
import readline from "node:readline/promises";
import { Agent } from "./agent.js";

const agent = new Agent();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("Sunrise Clinic scheduling assistant (type 'exit' to quit)\n");
console.log("Agent: Hello! I can help you book, reschedule, or cancel an appointment. How can I help?\n");

while (true) {
  const line = (await rl.question("You: ")).trim();
  if (!line || line === "exit") break;
  const before = agent.session.log.length;
  const reply = await agent.send(line);
  for (const c of agent.session.log.slice(before)) {
    console.log(`  [tool] ${c.name}(${JSON.stringify(c.args)}) -> ${c.result.ok ? "ok" : (c.result as any).error}`);
  }
  console.log(`\nAgent: ${reply}\n`);
}
rl.close();