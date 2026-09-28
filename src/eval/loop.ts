import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { MODEL } from "../config.js";
import { withRetry } from "../agent/agent.js";
import { loadRules, type RulesFile } from "../agent/prompt.js";
import { runAll, printResults, type ScenarioResult } from "./run.js";

const RULES_PATH = new URL("../rules.json", import.meta.url);
const MAX_ATTEMPTS = 2;

// Optional: limit the whole loop to some scenarios to save quota.
// npm run eval -- --only=cancel_too_late,emergency,privacy_other_patient
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",").filter(Boolean) : undefined;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function proposeRule(failed: ScenarioResult, rules: RulesFile, rejected: string[]): Promise<string> {
  const failedChecks = failed.checks.filter((c) => !c.pass).map((c) => ({ check: c.name, detail: c.detail }));
  const prompt = `You are improving the system prompt of a clinic appointment-scheduling chat agent.
A test scenario failed. Write ONE new rule to add to the agent's prompt so this kind of failure does not happen again.

Requirements for the rule:
- One or two sentences, imperative voice, addressed to the agent.
- General: describe the behaviour, not this specific test. Do not mention patient names, dates, appointment ids or the test.
- Must not contradict the existing rules or weaken safety, privacy or verification behaviour.
- Fix the actual cause visible in the transcript and tool log.

EXISTING LEARNED RULES:
${JSON.stringify(rules.rules.map((r) => r.text), null, 2)}

SCENARIO: ${failed.id} - ${failed.title}
FAILED CHECKS:
${JSON.stringify(failedChecks, null, 2)}

TRANSCRIPT:
${JSON.stringify(failed.transcript, null, 2)}

TOOL LOG:
${JSON.stringify(failed.toolLog, null, 2)}
${rejected.length ? `\nPREVIOUS ATTEMPTS THAT WERE REJECTED (do not repeat them):\n${rejected.join("\n")}\n` : ""}
Respond with JSON only: {"rule": "<the rule text>"}`;

  const res = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { temperature: 0, responseMimeType: "application/json" },
    })
  );
  const clean = (res.text ?? "").replace(/```json|```/g, "").trim();
  const rule = JSON.parse(clean).rule;
  if (typeof rule !== "string" || !rule.trim()) throw new Error("Proposer returned no rule");
  return rule.trim();
}

const current = loadRules();
console.log(`Loop starting with ${current.rules.length} learned rule(s), version ${current.version}.`);

// 1. Baseline
const baseline = await runAll(only, current);
printResults("baseline", baseline);

if (baseline.some((r) => r.error)) {
  console.log("\nSome scenarios errored (API problem, not a real failure). Fix that and rerun; nothing was changed.");
  process.exit(1);
}
const failing = baseline.filter((r) => !r.passed);
if (failing.length === 0) {
  console.log("\nNothing failing. No change made.");
  process.exit(0);
}

// 2. Take one failure. Everything that passed at baseline is the regression set.
const target = failing[0];
const regressionIds = baseline.filter((r) => r.passed).map((r) => r.id);
console.log(`\nTarget: ${target.id}. Regression set: ${regressionIds.join(", ") || "(none)"}`);

type Attempt = { rule: string; fixed: boolean; broke: string[]; errored: boolean; accepted: boolean };
const attempts: Attempt[] = [];
const rejected: string[] = [];
let accepted: RulesFile | null = null;

for (let n = 1; n <= MAX_ATTEMPTS && !accepted; n++) {
  const text = await proposeRule(target, current, rejected);
  console.log(`\nAttempt ${n} proposed rule:\n  ${text}`);

  const candidate: RulesFile = {
    version: current.version + 1,
    rules: [
      ...current.rules,
      { id: `r${current.rules.length + 1}`, text, source: `loop: ${target.id} / ${failing[0].checks.filter((c) => !c.pass).map((c) => c.name).join(", ")}` },
    ],
  };

  const after = await runAll([target.id, ...regressionIds], candidate);
  printResults(`candidate ${n}`, after);

  const errored = after.some((r) => r.error);
  const fixed = !!after.find((r) => r.id === target.id)?.passed;
  const broke = after.filter((r) => r.id !== target.id && !r.passed && !r.error).map((r) => r.id);
  const ok = !errored && fixed && broke.length === 0;
  attempts.push({ rule: text, fixed, broke, errored, accepted: ok });

  if (errored) {
    console.log("API errors during verification, so this rule can't be judged. Stopping without changes.");
    break;
  }
  if (ok) {
    accepted = candidate;
  } else {
    const why = !fixed ? "did not fix the failing scenario" : `broke: ${broke.join(", ")}`;
    console.log(`Rejected (${why}).`);
    rejected.push(`- "${text}" (${why})`);
  }
}

if (accepted) {
  fs.writeFileSync(RULES_PATH, JSON.stringify(accepted, null, 2) + "\n");
  console.log(`\nACCEPTED. rules.json updated to version ${accepted.version}. Failure fixed, no regressions.`);
} else {
  console.log("\nNo rule accepted. rules.json unchanged.");
}

fs.mkdirSync("results", { recursive: true });
const file = `results/loop-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify({ target: target.id, baseline, attempts, accepted: !!accepted }, null, 2));
console.log(`Loop report saved to ${file}`);