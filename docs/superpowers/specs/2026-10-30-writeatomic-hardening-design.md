# Design: `writeAtomic` concurrent-write hardening

Date: 2026-10-30 · Status: approved · Closes the §D deferred item
"Concurrent-write hardening for `writeAtomic`" in `docs/production-readiness.md`.

## Problem

`createNodeSettingsAdapter().writeAtomic` (src/main/services/settings-fs.ts) writes
to a fixed `${path}.tmp` before renaming. Two interleaved calls on the same path
can clobber each other's tmp file: the rename can deliver the wrong generation,
fail with ENOENT, or fail with EPERM/EBUSY while the other writer holds the tmp
handle open (Windows).

Real concurrent writers exist per path today:

- `settings.json` — runtime pair/apply/wipe writes racing renderer
  `launchAtLogin` toggles over IPC.
- `printers.json` — renderer add/update/remove racing the runtime's
  `replaceCloud` during config apply (the wipe is already guarded by the
  apply-chain drain; UI-vs-apply is not).

## Scope

Adapter-level only (user decision). `SettingsFileAdapter`'s public interface is
unchanged; `settings.ts` and `printers/store.ts` are untouched. Store-level
lost-update on `cached` (last-resolved-wins) remains out of scope — the checklist
item targets the tmp-file collision.

## Mechanism (all inside `settings-fs.ts`)

1. **Per-path write queue.** An adapter-instance `Map<string, Promise<void>>`
   maps each target path to the tail of a promise chain. `writeAtomic` chains
   its work onto the tail via `.then(run, run)` (a failed write must not poison
   the queue), stores its own completion promise as the new tail, and awaits it.
   Writes to the same path execute strictly in call order — the final file
   always holds the last-issued write's content. Different paths stay fully
   parallel.
2. **Unique tmp name.** Each write targets `${path}.${randomUUID()}.tmp`.
   Concurrent writers can never collide on a tmp file.
3. **Orphan sweep.** On a path's *first* write (tracked in a `Set<string>`),
   list the parent directory and best-effort `unlink` any `${basename}.*.tmp`
   sibling before writing. Safe because the queue plus Electron single-instance
   make this process the only writer to the path; anything pre-existing is a
   crash orphan. Sweep failures are ignored — the write proceeds, and a locked
   orphan is swept on the next launch. Sweeping lazily per path avoids the
   glob-at-construction problem (the adapter does not know its paths until
   first use).
4. **Rename retry.** On `EPERM` or `EBUSY` from `rename` (AV/indexer scanners
   briefly holding the destination handle), retry up to 3 total attempts with a
   short fixed backoff (25 ms). Any other error fails immediately.
5. **Self-cleanup.** If the write or any rename attempt fails, `unlink` the
   writer's own tmp best-effort before propagating.

## Error handling

Caller-visible semantics are unchanged: `writeAtomic` either delivers the full
contents or throws; on throw, stores keep their cached state exactly as today.
The sweep, cleanup unlinks, and retry backoff never throw.

## Dependency injection

The adapter accepts an optional `deps` parameter (`rename`, `writeFile`,
`unlink`, `readdir`, `randomUUID`) defaulting to the `node:fs/promises` and
`node:crypto` implementations, mirroring the codebase's injection convention.
This keeps the retry/cleanup logic testable without monkey-patching.

## Testing

New `tests/settings-fs.test.ts` (real fs, `mkdtemp` pattern, matching
`tests/job-engine-recovery.test.ts` etc.):

1. **Concurrent burst** — 20 interleaved `writeAtomic` calls on one path with
   distinct contents; final file parses and equals the last-issued call's
   content; no `.tmp` files remain.
2. **Parallel paths** — concurrent writes to two different paths both complete
   with correct contents (per-path isolation).
3. **Orphan sweep** — plant a fake `path.<uuid>.tmp` before the first write;
   it is gone after.
4. **Rename retry** — injected `rename` fails with `EPERM` twice then succeeds;
   write succeeds. Also: non-retryable error fails fast.
5. **Self-cleanup** — injected `writeFile` fails; tmp is gone, error propagated.

## Documentation

- `settings.ts`: extend the `writeAtomic` doc comment with the
  last-issued-write-wins guarantee.
- `settings-fs.ts`: drop the "untested" caveat from the module comment.
- `docs/production-readiness.md` §D: mark the row done (done-date + evidence
  pointer), consistent with how other items closed.
