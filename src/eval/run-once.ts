import "dotenv/config";
import fs from "node:fs";
import { runAll, printResults } from "./run.js";

const ids = process.argv.slice(2);
const results = await runAll(ids.length ? ids : undefined);
printResults("current rules", results);

fs.mkdirSync("results", { recursive: true });
const file = `results/run-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nfull transcripts and tool logs saved to ${file}`);