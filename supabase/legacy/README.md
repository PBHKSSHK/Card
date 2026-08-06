# Legacy migration files (historical reference only)

These 32 files are the original, hand-run patch scripts from the source
project (`hmkaibot-bot/cardrecon`). They were applied directly against a
live Supabase project over time — often overlapping, occasionally reverting
each other, with filenames like `RUN_ME_NOW_*.sql` reflecting how they were
actually used (pasted into the Supabase SQL editor one at a time, not run
through a migration tool).

**Do not run these against a new project.** They assume tables already
exist from an undocumented baseline that was never committed anywhere, and
several of them are superseded by later files in this same set (e.g. three
different implementations of `set_claim_batch_no()` across
`migration_fix_batch_no_race.sql`, `RUN_ME_NOW_sequence_fix.sql`, and
`RUN_ME_NOW_diagnose_v2.sql`).

The current, consolidated schema — reconstructed to the correct final state
these files converged on, verified end-to-end against a real Postgres
instance — lives in `../migrations/`. Use that for a fresh install. These
files are kept only so the reasoning behind specific RLS policies or
functions can be traced back to the original bug they fixed.
