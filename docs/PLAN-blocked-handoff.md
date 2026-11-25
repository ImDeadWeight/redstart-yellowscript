# Plan: hand off a blocker the run cannot clear

*As of 2026-11-24. Builds on the stuck-run checks in
[PLAN-agent-runtime.md](PLAN-agent-runtime.md) (agent-core `stagnation.mjs`,
detectors a to f).*

**What prompted it.** In a bench Crestline run (Ornith 1.5 9B Q6, `bench`
account, `sample-workspace/`, started 17:33), the model wrote the estimator and
its tests, and `npm run check` passed by 17:55. Then `npx vitest run` failed with
`TypeError: Cannot read properties of undefined (reading 'config')` at the first
`describe(`. The scaffold's own `greet.spec.ts` failed the same way. That failure
is not the model's: it comes and goes with no file changed, and when it fails the
test file has loaded a second copy of the `vitest` module, apparently a clash
between Vitest 5.1, SvelteKit 3.4 and Vite 8. When the runner did work, 11 of the
12 tests passed.

The model investigated well. It searched the web with the exact error, saved the
full output to a file, checked the installed versions, and read Vitest's source.
But at 19:00, more than an hour and 24 rounds after the first failure, it was
still investigating, and it had not told the person that it was blocked on
something outside its code.

| Round | Time | `npx vitest run` | Outcome |
|---|---|---|---|
| 49 | 17:55 | plain | failed |
| 52, 53 | 17:59, 18:03 | piped into `findstr` | **"ok"** (the exit code is `findstr`'s) |
| 54 | 18:14 | redirected to a file | failed |
| 60 | 18:30 | plain, after a `vite.config.ts` rewrite | failed |
| 61 to 73+ | 18:31 to 19:00+ | not run again | reading `node_modules/vitest`, web searches |

**Why nothing fired.** Every detector we have measures a *lack of progress*, and
this run was making progress: each round read a new file, ran a new command or
found a new search result. That is right for detectors c and e, but it means the
monitor has no rule for "making progress on investigating, getting nowhere on the
blocker". Detector a (the same failure 3 times) looks only at the last 8 rounds,
and the three failures spanned 11.

**What good looks like.** A 9B model should not be expected to fix a toolchain
bug in brand-new releases. It should be expected to notice it is blocked, and hand
off: what fails, what it ruled out, what it thinks the cause is (its code, or the
environment), and what it needs from the person. In this run that hand-off should
have come around round 61 (18:30), not after 19:00.

## The rule: an open blocker (detector g)

A **blocker** is a command family (`actionFamily()`, so `npx vitest run` whatever
its flags) that has failed and has not cleanly succeeded since. It opens on the
first failure, and the monitor records the round.

It **fires** when all of these hold:

1. it has been open for `blockedRounds` rounds (starting value 12);
2. it has failed at least `blockedFailures` times (starting value 2), so one early
   failure that the model rightly moved on from does not count;
3. its last two failures have the same error signature (`errorSignature()`). This
   is what tells a blocker apart from ordinary work through failing tests, where
   the failure changes as the code changes (a different test, a different count).

It **closes** when the same family succeeds **cleanly**: `ok`, and the command
line has no pipe (`|`) and no output redirect (`>`, `>>`). Rounds 52 and 53 above
would otherwise have closed it, because the exit code was `findstr`'s. A redirect
of stderr into stdout alone (`2>&1`) is fine. A run that fails *differently* also
keeps the blocker open, but resets the signature check (condition 3).

Progress does **not** reset it. That is the point: detector g is the only one that
is measured against the blocker, not against the run's activity.

### What happens when it fires

Its own two-step track, separate from the `level` that detectors a to f share,
so that an unrelated earlier "Changed approach" does not turn the first hand-off
into a stop:

1. **Hand-off note** (like level 1, at the tail of the next request):
   > `npx vitest run` has failed the same way for 12 rounds (since round 49):
   > "TypeError: Cannot read properties of undefined (reading 'config')". If you
   > cannot say what is left to try, stop and tell the person what fails, what you
   > have ruled out, whether you think the cause is your code or the environment
   > (the toolchain, versions, the machine), and what you need from them. Then ask
   > how to continue.

   When the host has `ask_user`, the note names it; otherwise "end your reply with
   the question". If a web tool is present and was not used on this error, the
   lookup hint is added as now.
2. **Stop** after another `blockedRounds` rounds with the blocker still open and
   no hand-off: the run ends as `stuck`, and the person gets the summary (the
   blocker, its error, the rounds, and what was tried most recently). It ends in a
   question, like the existing level 3 summary.

A hand-off ends the episode: an `ask_user` call, or a reply that ends in a
question and stops calling tools (`endsInQuestion()` in `update-plan.mjs`). The
person's answer starts a new run, and a new monitor.

## Work

### agent-core (redstart-project PR #59, `feat/stagnation`)

- `stagnation.mjs`:
  - New limits `blockedRounds: 12` and `blockedFailures: 2`. `STAGNATION_OFF`
    sets `blockedRounds: Infinity`.
  - A `blockers` map: family → `{ openedRound, failures, lastSignatures }`,
    updated in `record()`. "Cleanly" needs the raw command line, which the core
    already has in `call.args` (a `command` field): a small `cleanExit(args)` next
    to `actionFamily()`.
  - The check goes in `endRound()`, after the existing detectors, and returns a
    `Recovery` with `detector: 'blocked'`, `level: 1` or `3`, and a new field
    `handoff: true`, so hosts can render it as a hand-off rather than "Changed
    approach".
  - `createStagnationMonitor(limits, { lookupTools, askTool })`: `askTool` (say
    `ask_user`) is named in the note when the host has it.
- `test-agent-core.mjs`, using this run's call sequence as the fixture:
  - fires once, at round 61, with the vitest error in the evidence;
  - the piped `findstr` runs do not close the blocker;
  - test-driven work (the same family failing with a new signature each time it
    runs, with writes in between) never fires;
  - a clean success closes it;
  - the second firing stops the run;
  - with `STAGNATION_OFF` it is quiet.

### Yellowscript

- Re-sync agent-core. Add `'blocked'` to `Detector`, the two limits to
  `StagnationLimits`, and `handoff?: boolean` to `Recovery` in
  `src/agent/agent-core.ts`.
- `src/agent/loop.ts`: pass `askTool: 'ask_user'` when `ask_user` is in the tool
  list, next to `lookupTools`.
- `src/chat/session.ts` `recoveryLine()`: a hand-off reads `Asked to hand off:
  npx vitest run has failed the same way for 12 rounds.`, not `Changed approach:
  …`. The run log entry keeps `detector: 'blocked'`.
- Tests in `loop.test.ts`: the note reaches the next request's tail; an
  `ask_user` call after it ends the episode with no stop.

### Bench

- Save this run as a fixture once it ends: the chat is in the sample workspace's
  `state.vscdb`, account `bench`, started 2026-11-24 17:33. Replaying its calls
  through the monitor is the end-to-end test for detector g.
- Score hand-offs: `handedOff` (an `ask_user` or a closing question after a
  `blocked` recovery) next to `recoveries`, so a run that correctly gives up on an
  environment problem reads as a good outcome, not as an unfinished task.

## Open questions

- **The thresholds.** 12 rounds and 2 failures are set from this one run. Check
  them against the earlier Crestline fixtures (turns 1 and 2 of
  `conv_1795539588063_468eh9`) before trusting them, and against any long run
  that went through red tests to green.
- **Wall-clock time.** Rounds ignore time spent waiting on approvals, which is
  what we want. But one round of a slow command can take minutes. The monitor has
  no clock by design; a host could pass elapsed time to `endRound()` if rounds
  turn out to be too coarse.
- **Scripts with two names.** `npm test` and `npx vitest run` are the same check
  under two families. Mapping package.json scripts to what they run would merge
  them; leave it until a run shows it matters.

## Related, not part of this plan

The run hit a fresh upstream break because `npx sv create` and `sv add` install
whatever was released last. To measure the model rather than the week's releases,
the Crestline task should pin `sv` and its dependency versions, with a separate
"latest" variant for testing how the model copes with new releases.
