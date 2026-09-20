# Atelier's loop, in the field's vocabulary

> Architect-authored (atelier-go9, 2026-08-02). Maps the Atelier dispatch cycle onto
> the five-field loop specification (arXiv 2607.00038) and names the loop
> hierarchy the system already runs. Descriptive, not normative: the contracts
> live in [ARCHITECTURE.md](ARCHITECTURE.md) and the event-bus spec; this page
> makes them legible in the current loop-engineering language. Source analysis:
> an internal 2026-08 loop/graph-engineering survey.

## The dispatch cycle as a five-field loop

A loop, per the formal definition, is a reusable five-field specification —
**Trigger · Goal · Verification · Stopping Rule · Memory** — not an ad-hoc
script. The Atelier dispatch cycle was designed before the term existed and maps
onto it exactly:

| Field | Atelier implementation |
|---|---|
| **Trigger** | A dispatch call (turn-based), convoy progression (goal-based), or the ready queue (proactive tier — built, currently disabled by human decision). |
| **Goal** | The spec file / br ticket: Goal, Context, Constraints, Done-when — outcomes, not procedures. The goal artifact is owned by a slower loop than the one executing it (see hierarchy below). |
| **Verification** | The `node --test` full-suite verify gate on the real worktree — environment ground truth, never agent self-report — then an adversarial fresh-thread review, then the post-merge main check. |
| **Stopping rule** | Review verdict PASS; trajectory parking on non-convergence; a `needs_input` outcome; or the human merge decision. Every path terminates — there is no unbounded retry. |
| **Memory** | The br tracker, append-only review round history, the disposition store (mandatory actor on every entry), the chronicle, and git itself. Nothing load-bearing lives only in a context window. |

Two properties are worth naming because they are design choices, not accidents:

- **Verification is computed, never claimed.** The verify verdict comes from the
  suite's exit code on the real tree; the diff-verifier exists because
  "completed" does not mean "writes landed"; never-weaken-tests is doctrine.
- **Context reset per iteration.** A continuation dispatch starts with a fresh
  context and worktree, merges the predecessor branch, and re-reads state from
  durable artifacts (ticket, review rounds, dispositions). The re-read cost buys
  freedom from context drift.

## The loop hierarchy

Atelier runs speed-separated nested loops. Naming them (this section) is the whole
point — the mechanics already exist:

```
dispatch loop (minutes–hours)
  ⊂ ticket / review loop (hours: implement → verify → review → adjudicate → merge or park)
    ⊂ arc / roadmap loop (days: specs, slices, queue order)
      ⊂ human oversight loop (the maintainer: merge authority, routing overrides, scope decisions)
```

**Slow loops own fast loops' reference values.** The spec (slow) fixes what a
dispatch (fast) may aim at; a reviewer cannot change the spec it audits; the
architect cannot silently change the human's decisions. Corrections flow
downward as new briefs, evidence flows upward as verdicts and checkpoints —
neither level mutates the other's state directly.

**Audit loops verify reality-contact from outside the stack:** `atelier doctor`,
the post-merge main-health check, and `check-unmerged-branches` each compare
recorded state against the actual environment and surface divergence rather
than repairing it silently.

**Deliberate invariant: one level of nesting only.** Dispatches do not spawn
dispatches. Fan-out happens at the architect level (parallel dispatches over
disjoint surfaces); a worker that discovers out-of-scope work reports it and
stops. This keeps every running agent attributable to exactly one human-legible
loop position and is the direct mitigation for inter-agent misalignment failure
modes: agents that never talk mid-task cannot misalign mid-task.

## Related write-ups

Two positioning pieces build on this page and stay architect tasks outside
atelier-go9: the disposition layer as a third edge type (deterministic /
model-decided / human-adjudicated transitions), and trajectory parking as a
non-convergence metric.
