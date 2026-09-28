import { Agent, type Turn } from "../agent/agent.js";
import { loadRules, type RulesFile } from "../agent/prompt.js";
import type { ToolCall } from "../agent/tools.js";
import { scenarios, globalChecks, type Check, type Scenario } from "./scenarios.js";

export type ScenarioResult = {
  id: string;
  title: string;
  passed: boolean;
  checks: Check[];
  error?: string;
  transcript: Turn[];
  toolLog: ToolCall[];
};

export async function runScenario(s: Scenario, rules: RulesFile = loadRules()): Promise<ScenarioResult> {
  const agent = new Agent(rules);
  try {
    for (const t of s.turns) await agent.send(t);
  } catch (e: any) {
    return {
      id: s.id, title: s.title, passed: false, checks: [],
      error: e.message, transcript: agent.transcript, toolLog: agent.session.log,
    };
  }
  const ctx = { session: agent.session, transcript: agent.transcript };
  const checks = [...s.check(ctx), ...globalChecks(ctx)];
  return {
    id: s.id, title: s.title, passed: checks.every((c) => c.pass),
    checks, transcript: agent.transcript, toolLog: agent.session.log,
  };
}

export async function runAll(ids?: string[], rules: RulesFile = loadRules()): Promise<ScenarioResult[]> {
  const chosen = ids?.length ? scenarios.filter((s) => ids.includes(s.id)) : scenarios;
  const out: ScenarioResult[] = [];
  for (const s of chosen) {
    process.stdout.write(`running ${s.id} ... `);
    const r = await runScenario(s, rules);
    console.log(r.error ? `ERROR (${r.error.slice(0, 60)})` : r.passed ? "PASS" : "FAIL");
    out.push(r);
    await new Promise((res) => setTimeout(res, 1000));
  }
  return out;
}

export function printResults(label: string, results: ScenarioResult[]) {
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n=== ${label}: ${passed}/${results.length} scenarios passed ===`);
  for (const r of results) {
    if (r.error) console.log(`  ERROR ${r.id}: ${r.error}`);
    else if (!r.passed)
      for (const c of r.checks.filter((c) => !c.pass))
        console.log(`  FAIL  ${r.id} -> ${c.name}${c.detail ? " (" + c.detail + ")" : ""}`);
  }
}