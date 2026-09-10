---
name: forward-implementation-first
description: >
  Keeps an agent building and validating real output instead of servicing its
  own bookkeeping. Use for multi-stage pipelines, capability roadmaps,
  long-running implementation loops, migrations, staged data or build runs, and
  any run where administrative hashes, locks, receipts, dashboards,
  certification markers, or progress metadata can block correct work.
---

# Forward implementation first

Build working capability and correct output before administrative bookkeeping.
Apply this contract both while building a system and while running it.

## Decision rule

Before each action, classify it as one of:

1. **Semantic implementation**: builds or connects a producer, consumer,
   adapter, runtime path, schema, fixture, or final output.
2. **Focused validation**: tests the changed dependency cone through behavior,
   schema, counts, samples, conservation, consistency, nontruncation, or
   measured resources.
3. **Administrative bookkeeping**: generates or repairs hashes, locks,
   receipts, dashboards, certification markers, progress metadata, or
   presence-only records.

Choose categories 1 and 2. Skip category 3 unless the user asks for it or the
artifact is itself part of the product. When administrative work blocks a path
without protecting correctness, remove that dependency from the path.

## Hard constraints

- Build the producer and consumer before polishing status or certification surfaces.
- Do not generate, repair, compare, or propagate administrative hashes.
- Do not create or wait on filesystem locks.
- Do not rerun an unchanged stage to regenerate a receipt or marker.
- Never invalidate valid output because an administrative receipt, hash,
  certification marker, dashboard row, or progress record is missing or stale.
- Never move the forward cursor backward for an administrative metadata change.
- Replay only a changed producer's dependency cone.
- Do not treat certification, receipts, dashboards, progress metadata, or
  artifact presence as the product.
- Remove hash-only, lock-only, receipt-only, and presence-only gates from
  execution paths.
- Do not claim a capability works because its file exists. Run the smallest
  changed dependency cone and inspect the output.
- Publish valid output after focused validation. Do not add another review
  cycle when no defect remains.

## Forward cursor

Replay a stage only when its input meaning or pinned revision changed, its
output is malformed or incompatible, an observed run disproves it, or the
changed dependency cone requires replay. Missing administrative metadata is
not a reason.

When bookkeeping alone blocks an authorized stage:

1. Run the exact stage manually.
2. Validate the output with focused checks.
3. Publish the valid output atomically.
4. Continue from the forward cursor.
5. Remove or downgrade the administrative-only gate.

## Required validation

Use the checks that match the change:

- runtime behavior and exit status;
- schema and type validity;
- exact input, output, accepted, rejected, and unknown counts;
- deterministic first, middle, and last samples;
- identity and partition conservation;
- join consistency and flag polarity;
- nontruncation and bounded diagnostic output;
- wall-clock time and peak memory for material stages.

Hashes may identify inputs or revisions, but they never grant correctness,
execution, or roadmap credit.

## Execution discipline

- Run one heavy process at a time.
- Keep parallel workers on light, nonoverlapping implementation and focused-test lanes.
- The root lane alone owns heavy execution, publication, cursor movement,
  acceptance, and conclusions.
- Parallel lanes prepare, implement, inspect, and test nonoverlapping support work.
- Forward progress must not wait for every parallel lane to finish.
- Replay the smallest affected dependency cone from the forward cursor.
- Fix a defect in its owning stage before rerunning the cone.
- If the next action is bookkeeping-only, select the next unresolved producer,
  consumer, adapter, or output instead.

## Status reporting

Report implemented behavior and measured output first. List blockers literally.
Keep infrastructure progress separate from evidence about the output. Do not
turn administrative completion into a substitute for working capability.
