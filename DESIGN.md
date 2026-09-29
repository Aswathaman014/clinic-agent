# Design Note: Clinic Appointment Scheduling Agent

**Time spent:** ~9 hours. **AI tools:** Claude (Sonnet), for the full build - scaffold, tools, eval harness, and improvement loop.

## Key design choices

**Guardrails live in code, not just the prompt.** verifiedPatientId on the session object is set only by verify_patient, and every mutating tool (book_appointment, reschedule_appointment, cancel_appointment) checks it server-side. The model cannot skip verification by ignoring an instruction, because the check does not depend on the model following one. Clinic hours, slot conflicts, appointment ownership, and the 2-hour cancellation window are enforced the same way. This mattered in practice: a bug in find_slots (silently truncating results to 10, hiding a valid 2pm slot) caused a real scenario failure, but it never caused a safety failure, because ownership and hours checks are independent of what the tool happens to return.

**Errors do not leak information.** A wrong name or DOB during verification returns the same message either way, so the agent cannot be used to confirm whether a patient exists. A request for another patient's appointment returns "not found" rather than "belongs to someone else," so cross-patient probing gets no signal back.

**Scoring is state-based, not transcript-only.** Each scenario checks the final database state and the tool-call log, not just what the agent said. This caught a real class of bug that a transcript-only judge would miss: in one run, the agent's reply sounded reasonable ("staff have been notified") while never actually stating that the cancellation had failed and the appointment was still booked - a fact only visible by reading the DB and the last reply's content together. I added a scenario check for that specific gap (explains_why_not_cancelled) once I noticed it.

**10 scenarios cover intentional hard cases**, not just the happy path: an emergency (chest pain), a privacy probe (asking about another patient), a cancellation blocked by the 2-hour window, identity verification refusal, out-of-hours booking, a taken-slot conflict, a cross-patient cancellation attempt, and a reschedule that requires seeing a full day's slots. Two global checks apply everywhere: no double-booked slots, and no claiming success in the reply without a corresponding successful tool call.

## How the improvement loop works

1. Baseline: run the target scenarios against the current prompt (base instructions plus any learned rules from rules.json).
2. Propose: for one failing scenario, send its transcript, tool log, and failed checks to the model and ask for one general prompt rule - or a null verdict if the failure is not a prompt problem at all (e.g. a tool bug).
3. Verify: re-run the failing scenario plus every scenario that passed at baseline (the regression set), using a candidate prompt with the new rule appended.
4. Accept or reject: the rule is written to rules.json only if the target scenario now passes and nothing in the regression set broke. A doubtful result (an API error, or an unexpected regression) gets re-run once before the final verdict, so a transient 503 does not reject a good rule.

This is deliberately conservative: one rule per cycle, checked against everything that already worked, discarded on any doubt.

## Before / after

Scenario: cancel_too_late - a patient's cancellation is correctly blocked by the 2-hour window, but the agent's final reply never says the appointment is still booked or why.

- Baseline: 2/3 scenarios passed (emergency, privacy_other_patient pass; cancel_too_late fails on explains_why_not_cancelled).
- Fix applied (both by hand and by the automated loop, independently): one rule - when a tool refuses an action, state plainly what could not be done and why before saying staff were notified.
- After: 3/3 scenarios passed, regression set intact.

I also ran the same failure through the loop with rules.json emptied first, and it independently found and accepted a rule for the same fix.

## Where AI helped vs. where my judgment overrode it

- The loop's first two auto-generated rule attempts on a different failure (reschedule) were confident but wrong - they assumed the agent was creating duplicate bookings. Reading the actual transcript showed the real cause was a tool bug (find_slots silently truncating results to 10, hiding a valid slot), not a prompt problem. No prompt rule could have fixed it. I fixed the tool instead, and added a "not a prompt problem" exit to the loop so it can say so explicitly rather than guessing.
- The loop's accepted rule for cancel_too_late was narrower than my hand-written one - it named the specific "2 hours" wording rather than covering tool refusals generally. It passed the check but likely would not generalize as well; I kept both versions in git history rather than treating the loop's output as final.
- I added the explains_why_not_cancelled check myself after noticing the agent's reply was misleading in a way none of the existing state checks caught - the loop only improves against checks that already exist.

## One thing I would change for production

Replace the in-memory mock database with a real EHR/calendar integration, and add a lightweight LLM-judge pass alongside the state checks for tone and empathy - state checks confirm what happened, but a patient in distress (the emergency scenario, for instance) also needs to be told things well, not just correctly, and regex-based text checks are too brittle to certify that.

## Known limitations

- Patient turns are scripted, not adaptive - the "patient" cannot react to what the agent actually says, so the harness cannot test recovery from an agent's own mistake mid-conversation.
- Checks are mostly regex over reply text plus DB/log state, which is precise but brittle to rewording; a couple of the loop's own generated rules exploited this narrowness.
- Each verdict is one run at temperature 0 - one sample, not statistical confidence.
- The same model proposes rules and runs the agent, so it can share the agent's blind spots.
- Free-tier API quota limits meant most verification runs targeted small scenario subsets rather than the full 10 every time.
