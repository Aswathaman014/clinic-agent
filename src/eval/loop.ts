import "dotenv/config";
import fs from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { MODEL } from "../config.js";
import { withRetry } from "../agent/agent.js";
import { loadRules, type RulesFile } from "../agent/prompt.js";
import { runAll, printResults, type ScenarioResult } from "./run.js";

const RULES_PATH = new URL("../rules.json", import.meta.url);
const MAX_ATTEMPTS = 2;

// Optional scenario ids to limit the loop (saves quota):
//   npm run eval -- reschedule cancel_too_late emergency
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--")).flatMap((a) => a.split(","));
const only = ids.length ? ids : undefined;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Returns a rule, or null when the proposer judges the failure is not caused by the prompt.
async function proposeRule(failed: ScenarioResult, rules: RulesFile, rejected: string[]): Promise<string | null> {
  const failedChecks = failed.checks.filter((c) => !c.pass).map((c) => ({ check: c.name, detail: c.detail }));
  const prompt = `You are improving the system prompt of a clinic appointment-scheduling chat agent.
A test scenario failed. Decide whether the failure is caused by the agent's prompt. If it is, write ONE new rule to add to the prompt.

First read the transcript and tool log carefully. If the agent's behaviour was reasonable given what the tools returned (so the cause is a bug in a tool or in the test, not the prompt), respond {"rule": null}.

Requirements for a rule:
- One or two sentences, imperative voice, addressed to the agent.
- General: describe the behaviour, not this specific test. Do not mention patient names, dates, appointment ids or the test.
- Must not contradict the existing rules or weaken safety, privacy or verification behaviour.
- Fix the actual cause visible in the transcript and tool log. Do not guess a cause that the evidence does not show.

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
Respond with JSON only: {"rule": "<the rule text>"} or {"rule": null}`;

  const res = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { temperature: 0, responseMimeType: "application/json" },
    })
  );
  const clean = (res.text ?? "").replace(/```json|```/g, "").trim();
  const rule = JSON.parse(clean).rule;
  if (rule === null) return null;
  if (typeof rule !== "string" || !rule.trim()) throw new Error("Proposer returned an invalid rule");
  return rule.trim();
}

// Re-run anything doubtful once (API errors, or non-target scenarios that failed) and use the second verdict.
// A target that failed cleanly is a real failure and is not re-run.
async function rerunIfDoubtful(results: ScenarioResult[], rules: RulesFile, targetId: string) {
  const doubtful = results.filter((r) => r.error || (!r.passed && r.id !== targetId)).map((r) => r.id);
  if (doubtful.length === 0) return results;
  console.log(`\nRe-running once to rule out flakiness: ${doubtful.join(", ")}`);
  const again = await runAll(doubtful, rules);
  return results.map((r) => again.find((x) => x.id === r.id) ?? r);
}

const current = loadRules();
console.log(`Loop starting with ${current.rules.length} learned rule(s), version ${current.version}.`);

// 1. Baseline
const baseline = await runAll(only, current);
printResults("baseline", baseline);

if (baseline.some((r) => r.error)) {
  console.log("\nSome scenarios errored (API problem, not a real failure). Rerun later; nothing was changed.");
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

type Attempt = { rule: string | null; fixed?: boolean; broke?: string[]; errored?: boolean; accepted: boolean };
const attempts: Attempt[] = [];
const rejected: string[] = [];
let accepted: RulesFile | null = null;
let notPromptProblem = false;

for (let n = 1; n <= MAX_ATTEMPTS && !accepted; n++) {
  const text = await proposeRule(target, current, rejected);
  if (text === null) {
    console.log("\nThe proposer thinks this failure is NOT caused by the prompt (likely a tool or test bug). Inspect the transcript.");
    attempts.push({ rule: null, accepted: false });
    notPromptProblem = true;
    break;
  }
  console.log(`\nAttempt ${n} proposed rule:\n  ${text}`);

  const failedNames = target.checks.filter((c) => !c.pass).map((c) => c.name).join(", ");
  const candidate: RulesFile = {
    version: current.version + 1,
    rules: [...current.rules, { id: `r${current.rules.length + 1}`, text, source: `loop: ${target.id} / ${failedNames}` }],
  };

  let after = await runAll([target.id, ...regressionIds], candidate);
  printResults(`candidate ${n}`, after);
  after = await rerunIfDoubtful(after, candidate, target.id);

  const errored = after.some((r) => r.error);
  const fixed = !!after.find((r) => r.id === target.id)?.passed;
  const broke = after.filter((r) => r.id !== target.id && !r.passed && !r.error).map((r) => r.id);
  const ok = !errored && fixed && broke.length === 0;
  attempts.push({ rule: text, fixed, broke, errored, accepted: ok });

  if (errored) {
    console.log("API errors persisted after a re-run, so this rule can't be judged. Stopping without changes.");
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
  console.log(`\nNo rule accepted. rules.json unchanged.${notPromptProblem ? " (Likely not a prompt problem.)" : ""}`);
}

fs.mkdirSync("results", { recursive: true });
const file = `results/loop-${Date.now()}.json`;
fs.writeFileSync(file, JSON.stringify({ target: target.id, baseline, attempts, accepted: !!accepted }, null, 2));
console.log(`Loop report saved to ${file}`);