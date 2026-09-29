# Clinic Appointment Scheduling Agent

A patient-facing chat agent for a clinic's appointment scheduling (book, reschedule, cancel), built with Google Gemini function calling, plus an evaluation harness and an improvement loop that turns failing scenarios into prompt fixes and re-verifies them.

## Setup

npm install

Create a .env file in the project root:

GEMINI_API_KEY=your-key-here

Get a key at https://aistudio.google.com/apikey. The model used is set in src/config.ts.

## Run the agent

npm run chat

Starts an interactive chat session in the terminal. Try, for example: "Hi, I need to see a skin doctor on Thursday 1 October."

## Run the evaluation harness

Run one or more scenarios by id:

npm run eval:run -- happy_path
npm run eval:run -- emergency cancel_too_late
npm run eval:run

Results (full transcripts and tool call logs) are written to results/run-*.json.

## Run the improvement loop

npm run eval -- cancel_too_late emergency privacy_other_patient
npm run eval

This runs the given scenarios as a baseline, and if any fail, it:
1. Sends the failing transcript and tool log to the model and asks for one general prompt rule (or a null verdict if the failure is not a prompt problem, e.g. a tool bug).
2. Re-runs the target scenario plus every scenario that passed at baseline (the regression set), using a candidate prompt with the new rule appended.
3. Re-runs anything doubtful (API errors, unexpected regressions) once before making a final call.
4. Only writes the rule to src/rules.json if the target is fixed and nothing in the regression set broke. Otherwise the rule is discarded and reported.

A full report (baseline, every attempt, accept/reject reasoning) is written to results/loop-*.json.

## Project structure

src/
  agent/
    db.ts          fixed clinic dataset and deterministic clock
    tools.ts       scoped tools with server-side guardrails (verification, ownership, hours)
    prompt.ts      base system prompt plus rules.json injection
    agent.ts       Gemini chat loop, tool execution, retry/backoff
    cli.ts         interactive terminal chat
  eval/
    scenarios.ts   10 scored scenarios including hard cases (privacy, emergency, refusals)
    run.ts         scenario runner plus global checks (no double-booking, no false success claims)
    run-once.ts    CLI entry for a single eval run
    loop.ts        the improvement loop described above
  rules.json       learned rules, appended to the prompt at runtime
  config.ts        model name (single point of change)

## Notes

- NOW in db.ts is a fixed clock (2026-09-28T10:00, a Monday) so every eval run is deterministic and reproducible.
- Server-side guardrails are enforced in tools.ts, not just described in the prompt: identity verification, appointment ownership, and clinic hours are checked in code regardless of what the model does.
- Retries in agent.ts handle transient 503/500/429 errors and network drops with exponential backoff, and fail fast (without retrying) on daily quota exhaustion.
- See DESIGN.md for the design note, before/after results, and known limitations.
