# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a bounded five-field cron parser with no dependency, covering `*`, values,
  ranges, wrapping ranges, steps, lists, month and weekday names, weekday `7`
  as Sunday, and the `@yearly` / `@monthly` / `@weekly` / `@daily` / `@hourly`
  macros, with Vixie day-of-month / day-of-week OR semantics;
- explicit rejection of extended cron syntax (`L`, `W`, `#`, `?`), of a step on
  a single value, of `@reboot`, and of anything that is not exactly five fields;
- wall-clock to instant resolution built on `Intl.DateTimeFormat`, reporting a
  spring-forward gap as `dst-skipped`, a fall-back overlap as `dst-ambiguous`
  with both instants, and a run crossing a transition as `dst-transition-in-run`;
- `analyzeSchedules`, expanding every job over an explicit UTC horizon in an
  explicit time zone and reporting self overlap, cross-job overlap, declared
  resource contention, maintenance-window intrusion and unused reserved windows;
- two independent expansion bounds - a bounded horizon in calendar days and a
  per-job and total occurrence cap - so a schedule such as `* * * * *` stops at
  its cap instead of exhausting the process, with a finding naming the limit and
  the number of jobs left unexpanded;
- a CLI writing the JSON report to stdout only and diagnostics to stderr, with
  `--help`, `--version`, `--json`, `--label` and exit codes 0 / 1 / 2;
- runnable clean, spring-forward, fall-back and unbounded examples;
- the rule catalog, limit table and determinism guarantee in
  `docs/schedule-rules.md`.

### Fixed

- `limit-comparisons-exceeded` now makes the report `incomplete` and the exit
  code `2`, as `docs/schedule-rules.md` already documented for every bound. A
  truncated overlap sweep used to be reported as a completed `fail` / exit `1`,
  which read as full coverage of the pairs it never compared.

No release has been published.
