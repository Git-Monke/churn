# Live progress for `churn migrate`

## Context

`churn migrate` can run for hours (a media library on spinning disks), but the
long part is silent. `migrate::copy` already asks rsync for progress:

```rust
// src/migrate.rs:copy
.args(["-aH", "--numeric-ids", "--partial", "--info=progress2", ...])
```

`system::run_streaming` splits rsync's `\r`-separated updates into individual
lines and hands each one to the callback, so the data reaches churn today:

```
^M         32,768   0%    0.00kB/s    0:00:00  ^M     41,943,040 100%    3.00GB/s    0:00:00 (xfr#1, to-chk=0/2)
```

The call site (`src/main.rs:1142`) then throws it away:

```rust
let mut live = LiveLog::start(format!("copying {} to {}", …));
let copied = migrate::copy(&plan.source, &plan.destination, &mut |line| live.push(line));
```

`LiveLog::push` runs every line through `compose::Event::parse`, which only
accepts `docker compose --progress json` objects. rsync lines are not JSON, so
`push` returns early and the spinner shows one frozen "copying …" line for the
entire copy.

The other long phases have the same shape:

| Phase | Today | Duration driver |
| --- | --- | --- |
| `migrate::plan` → `scan_tree` | nothing on screen | full source tree walk |
| `migrate::copy` | frozen spinner | bytes copied |
| `migrate::verify_tree` | spinner, no counts | full source tree walk |
| `migrate::remove_old_data` (`--move`) | spinner, no counts | file count |

`cp -a` is the fallback when rsync is missing and reports nothing at all.

## Facts established

- rsync emits `--info=progress2` updates even when stdout is a pipe, so no tty
  is needed. The last update is followed by a normal `\n`; the earlier ones are
  `\r`-terminated.
- Byte counts use thousands separators (`41,943,040`), the rate uses SI-ish
  suffixes (`3.00GB/s`), the ETA is `H:MM:SS`, and the tail is
  `(xfr#1, to-chk=0/2)` — i.e. files transferred and files left to check. The
  percentage is an integer `0%`–`100%`.
- With default incremental recursion, rsync's percentage is relative to the
  bytes **it still has to transfer**, not to `plan.total_bytes`. Resuming a copy
  where 40 MiB of 42 MiB already exist reports `100%` at 2 MiB.
  `--no-inc-recursive` makes the percentage relative to the whole tree
  (`2,097,152 4%` in the same test) at the cost of a full file-list build before
  the first byte moves.
- cliclack (vendored) already offers `progress_bar(len)` with `set_position`,
  `set_message` and templates such as
  `"{msg} [{elapsed_precise}] [{bar:30.cyan/blue}] {bytes}/{total_bytes} ({eta})"`.
  `format_progress_message` also renders multi-line messages with the house
  `│` gutter, so a bar plus several detail rows is already supported.
- `LiveLog` clears its bar in `Drop`, which is what keeps Ctrl-C clean. Any new
  renderer must do the same.

## Decisions

1. **Drive the bar from rsync's own percentage, not from `plan.total_bytes`.**
   Length 100, position = parsed percentage. This is self-consistent on a fresh
   copy and on a resume, where the plan's `remaining_bytes` is only a
   size-based estimate. Absolute bytes, rate, ETA and file counts go in the
   message.
2. **Keep `--info=progress2` without `--no-inc-recursive`.** The jumpy total is
   invisible because the bar is percentage-driven, and avoiding the full
   file-list build keeps the first byte moving immediately. Revisit only if the
   message's byte total proves confusing.
3. **Parse in `migrate.rs`, render in `live.rs`.** `migrate::copy` gains a typed
   `CopyEvent` callback so the parser is unit-testable without a terminal and
   the renderer stays a presentation concern.
4. **`cp -a` keeps the existing indeterminate spinner.** It prints nothing
   parseable; a fake bar would be dishonest. The call site picks the renderer
   up front with `system::which("rsync")`.
5. **No new dependencies.** The parser is a hand-rolled `split_whitespace` /
   `strip_suffix('%')` walk; `console` and `cliclack` are already in the tree.
6. **No behaviour change** to preflight, verification, `.env` rewriting,
   rollback, marker handling or exit codes. Progress is presentation only.

## Approach

### 1. Typed copy events (`src/migrate.rs`)

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Progress2 {
    pub bytes: u64,          // bytes transferred so far
    pub percent: u8,         // rsync's own 0–100
    pub rate: String,        // "3.00GB/s", verbatim
    pub eta: String,         // "0:00:12", verbatim
    pub files_done: u64,     // xfr#
    pub files_left: u64,     // to-chk=
    pub files_total: u64,    // to-chk total
}

pub enum CopyEvent<'a> {
    Progress(Progress2),
    Line(&'a str),           // anything else rsync printed
}

/// Parse one `--info=progress2` update; `None` for any other output.
pub fn parse_progress2(line: &str) -> Option<Progress2>;

pub fn copy(
    source: &Path,
    destination: &Path,
    on_event: &mut dyn FnMut(CopyEvent<'_>),
) -> io::Result<()>;
```

- Keep `run_streaming` untouched; adapt inside `copy`:
  `&mut |line| match parse_progress2(line) { Some(p) => on_event(CopyEvent::Progress(p)), None => on_event(CopyEvent::Line(line)) }`.
- Parser rules: trim, split on whitespace; accept a line only when the first
  field is a comma-grouped integer, the second ends in `%`, and the third looks
  like a rate (`…B/s`). Strip commas before `u64::from_str`. Extract
  `xfr#N`, `to-chk=L/T` from the trailing parenthesised field; leave them at 0
  when absent. Reject rather than guess, so `deleting …` / `skipping …` /
  `rsync: …` lines still reach the log and the error tail.
- Rate/ETA stay strings: re-formatting them would only fight rsync's own
  locale-free formatting.
- `on_event` is `FnMut`, single-threaded, stable order — same contract as
  `run_streaming`.

### 2. Determinate variant of `LiveLog` (`src/live.rs`)

```rust
impl LiveLog {
    pub fn spinner(title: impl Display) -> Self;      // today's `start`
    pub fn progress(title: impl Display, len: u64) -> Self;
    pub fn set_position(&mut self, position: u64);
    pub fn set_detail(&mut self, rows: &[String]);    // replaces the message rows
}
```

- Keep the existing `start`/`push`/`success`/`error`/`Drop` behaviour; rename
  `start` to `spinner` at call sites (mechanical, 3 sites) or keep `start` as an
  alias to avoid churn.
- `progress` uses `progress_bar(len).with_template(…)` following the vendored
  download template, but with a `{msg}` line above the bar so the detail rows
  keep the `│` gutter already used for compose events.
- Non-tty fallback: `progress` must **not** print every update. Emit a plain
  `percent% · bytes · rate · ETA` line only when the decile changes (10 %, 20 %,
  …) and always at 100 %. Lines arriving through `push`/`CopyEvent::Line` keep
  printing as today.
- `success`/`error`/`Drop` clear the bar first, exactly like the spinner path, so
  no half-drawn bar survives an error or Ctrl-C.

### 3. Wire it up (`src/main.rs::migrate_storage`)

```rust
let rsync = system::which("rsync");
let mut live = if rsync {
    LiveLog::progress(title, 100)
} else {
    LiveLog::spinner(title)
};
let copied = migrate::copy(&plan.source, &plan.destination, &mut |event| match event {
    CopyEvent::Progress(p) => live.show_progress(&p),   // set_position + detail rows
    CopyEvent::Line(line) => live.push(line),
});
```

- Detail rows for the bar: `1.24 GiB · 120.0 MB/s · ETA 0:00:12` and
  `1 234 / 8 901 files`. When `files_total` is 0, show only the byte row.
- `live.success(format!("copied {}", format_bytes(plan.total_bytes)))` stays as
  the final line, so the summary does not depend on the last progress frame.
- The failure path (`live.error("copy failed; the old data is untouched")`) is
  unchanged; `output.tail` in `migrate::copy` still collects the deduped last
  200 lines, progress included, so failure messages and
  `copy_failure_explanation` keep working. Consider filtering progress-only
  lines out of `tail` before formatting the error, so the diagnostic is not 200
  progress frames; keep at least the last frame for context.

### 4. Spinner for the silent phases (follow-up in the same bean, optional split)

- `plan()`: add `migrate::plan_with_progress(…, on_scan)` or a lightweight
  `scan_tree_with_progress(path, on_entry)` used by both `plan` and
  `verify_tree`. Throttle to ~4 updates/second; show
  `measuring … 12 345 files, 1.2 TiB`. Cheap and removes the "did it hang?"
  pause before the confirmation screen.
- `verify_tree`: same walker with a callback →
  `verifying … 1 234 / 8 901 files (<n>%)`. Needs the total file count, so add
  `total_files: u64` (and optionally `total_links`) to `migrate::Plan`, filled
  from the `TreeStats` that `plan()` already computes. `Plan` is `PartialEq` in
  tests — update the two existing assertions.
- `remove_old_data`: iterate top-level entries with a spinner that shows
  `removing 3/17 …`, mirroring the uninstall loop at `src/main.rs:887`.

### 5. Tests

- `src/migrate.rs` unit tests for `parse_progress2`:
  - a mid-copy frame with commas and `to-chk`;
  - the `\r`-stripped final frame;
  - a resume frame capped at `100%` with a small byte count;
  - rejection of `deleting media/…`, `skipping directory`, empty lines, and
    `rsync error: …`;
  - `0%` and the `to-chk=0/0` edge case (no division by zero anywhere).
- `src/live.rs`: extend the existing test with a non-tty throttle test — ten
  updates at 1 % intervals produce one printed line; updates at 10, 20, …, 100
  produce ten.
- Optional integration test in `tests/system.rs` style: put a fake `rsync` shell
  script on `PATH` that prints three progress frames and exits 0, then assert
  `migrate::copy` delivered three `Progress` events and zero `Line` events. The
  suite already fakes `PATH` for docker, so the harness exists.
- All four `cargo test`, `cargo fmt --check`, `cargo clippy` clean.

### 6. Docs (`docs/src/server.md`, migrate section)

One sentence after the rsync sentence: the copy shows a live progress bar with
bytes, rate, ETA and file counts, and falls back to a spinner when rsync is not
installed. Note that progress lines are suppressed when stderr is not a
terminal.

## Effort

| Part | Rough size |
| --- | --- |
| `parse_progress2` + `CopyEvent` + tests | ~120 lines, no new deps |
| `LiveLog::progress` + throttle + tests | ~90 lines |
| `main.rs` call site | ~20 lines |
| Silent-phase spinners (section 4) | ~80 lines, touches `Plan` |
| Docs | ~5 lines |

Sections 1–3 are the user-visible win and are self-contained. Section 4 can ship
in the same bean or be split into a follow-up if we want a smaller diff.

## Risks

- **Parser drift across rsync versions.** Mitigation: reject anything that does
  not match the full shape, so an unrecognised format degrades to today's
  behaviour (spinner + line log) rather than showing wrong numbers.
- **Duplicate frames.** `LineAssembler` already drops a line identical to the
  previous one, which is what removes the doubled final frame seen in testing.
  Do not add dedup on top.
- **Terminal reuse.** A bar drawn while `cliclack` is mid-prompt would corrupt
  the display; the copy runs strictly after the confirm prompt and after
  `stop_stacks`, so no prompt is live.
- **Ctrl-C.** `Drop` clears the bar; the marker on the destination keeps the
  resume path intact — unchanged by this work.
