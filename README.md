# Cron Collision Checker

Detect overlapping schedules, timezone ambiguity and missed maintenance windows.

- **Repository:** [edilec/cron-collision-checker](https://github.com/edilec/cron-collision-checker)
- **Area:** Automation & Workflows
- **License:** MIT

## The problem

A crontab tells you when a job *starts*. It does not tell you that two jobs will
be hammering the same database at 02:30, that a nightly run is still going when
the morning report begins, that the 02:00 job silently vanishes on the Sunday the
clocks spring forward, or that the 01:30 job runs twice on the Sunday they fall
back. Those answers need the schedules expanded into real instants, in a real
time zone, with a real duration attached.

This tool does that expansion over a bounded horizon and reports what collides.
It reads local JSON, writes a JSON report, and never touches the network.

## Install

Node 22 or newer. No runtime dependencies and no build step.

```sh
git clone https://github.com/edilec/cron-collision-checker.git
cd cron-collision-checker
npm run check
```

## Commands

```sh
cron-collision-checker --config FILE [--json] [--label NAME]
cron-collision-checker --help
cron-collision-checker --version
```

| Option | Meaning |
| --- | --- |
| `--config FILE` | schedule configuration to check (JSON, max 1 MiB) |
| `--label NAME` | value recorded as `location.file`; use it to keep a host path out of the report |
| `--json` | suppress the human summary on stderr |

Project scripts:

```sh
npm run lint           # node --check over every shipped source and test file
npm test               # node --test
npm run test:coverage  # node --test with coverage over src/
npm run example        # run the clean example
npm run pack:check     # npm pack --dry-run
npm run check          # lint, test, example and pack:check in one pass
```

## Input

One JSON file. `timezone`, `horizon` and a per-job `durationMinutes` are all
required and explicit: the tool refuses to guess any of them.

```json
{
  "timezone": "America/New_York",
  "horizon": { "start": "2026-03-07T00:00:00Z", "end": "2026-03-10T00:00:00Z" },
  "jobs": [
    { "id": "daily-2am", "cron": "0 2 * * *", "durationMinutes": 30, "resource": "etl" },
    { "id": "midnight-span", "cron": "45 23 * * *", "durationMinutes": 90, "resource": "etl" }
  ],
  "maintenanceWindows": [
    { "id": "storage-freeze", "start": "2026-03-09T03:30:00Z", "end": "2026-03-09T05:00:00Z" }
  ]
}
```

Unknown keys are rejected at every level rather than ignored, so a one-character
typo is reported as a configuration error (`incomplete`, exit `2`) instead of
quietly checking nothing and reporting a pass.

The full field reference, the supported cron grammar and every rule id live in
[`docs/schedule-rules.md`](./docs/schedule-rules.md).

Runnable examples:

| File | What it shows | Exit |
| --- | --- | ---: |
| `examples/clean.json` | a week of schedules with nothing to report | `0` |
| `examples/spring-forward.json` | a run lost to the spring-forward gap, a job spanning midnight colliding with the next morning, and a maintenance-window intrusion | `1` |
| `examples/fall-back.json` | wall-clock times that occur twice, and a run whose wall clock crosses the transition | `1` |
| `examples/unbounded.json` | `* * * * *` stopped by the occurrence bound | `2` |

## Output

stdout carries the JSON report and nothing else, so it can be piped straight
into a parser. stderr carries the human summary and progress diagnostics.

```sh
cron-collision-checker --config examples/spring-forward.json --json | jq '.findings[0]'
```

```json
{
  "ruleId": "dst-skipped",
  "severity": "error",
  "message": "job \"daily-2am\" is scheduled for 1 wall-clock time(s) on 2026-03-08 that do not exist in America/New_York because the clock springs forward",
  "location": { "file": "examples/spring-forward.json", "pointer": "/jobs/0/cron" },
  "evidence": "skipped: 2026-03-08 02:00",
  "suggestion": "Move the schedule outside the spring-forward gap, or accept that the run is dropped that day."
}
```

The envelope follows the Edilec report contract v1:

```json
{
  "schemaVersion": "1",
  "tool": "cron-collision-checker",
  "status": "pass",
  "summary": {
    "checked": 3, "errors": 0, "warnings": 0,
    "jobs": 3, "occurrences": 13, "collisions": 0,
    "maintenanceWindows": 2, "dstSkipped": 0, "dstAmbiguous": 0
  },
  "findings": []
}
```

`checked` counts the jobs actually expanded. When it is lower than `jobs`, a
bound stopped the run early and `status` is `incomplete`.

### Library use

```js
import { analyzeSchedules, exitCodeFor, serializeReport } from 'cron-collision-checker'

const report = analyzeSchedules(config, { configLabel: 'schedules.json' })
process.stdout.write(`${serializeReport(report)}\n`)
process.exitCode = exitCodeFor(report)
```

`parseCron`, `parseUtcInstant`, `formatReport`, `DEFAULT_LIMITS` and
`HARD_LIMITS` are exported too.

## Exit codes

| Code | Status | Meaning |
| ---: | --- | --- |
| `0` | `pass` | every schedule was expanded and no error-severity finding was raised |
| `1` | `fail` | schedules were expanded and at least one error-severity finding was raised |
| `2` | `incomplete` | invalid configuration, unreadable input, or a bound was exceeded |

Input that could not be read or fully expanded is `incomplete` and exits `2`. It
is never reported as a pass.

## Limits and non-goals

**What this tool cannot conclude.**

- **It cannot tell you your jobs actually ran.** It expands a declared schedule.
  It has no access to a scheduler, a run history or a machine, so it cannot know
  about a job that was paused, failed, retried, throttled, or started late.
- **It cannot tell you a run really takes `durationMinutes`.** That number is an
  input you assert. Every overlap conclusion is only as good as that estimate,
  and a job whose real runtime varies will collide in ways this report does not
  show.
- **It cannot tell you an overlap is a problem.** Two jobs overlapping is a
  `warning` unless both declare the same `resource`. The tool has no model of
  what your jobs contend for; declaring `resource` is how you tell it.
- **It cannot tell you what your scheduler does across a fall-back overlap.**
  Vixie cron, systemd timers, Kubernetes CronJobs and hosted schedulers disagree
  about whether an ambiguous wall-clock time fires once or twice. This tool
  reports the ambiguity and analyses the earlier instant; deciding what your
  scheduler does is your job.
- **It cannot check anything outside the horizon.** A collision that only
  happens on 29 February, or in a month the horizon does not cover, is not
  found. A `cron-no-occurrences` warning means exactly that: the job proved
  nothing.
- **A partial expansion proves nothing about the rest.** When a bound stops the
  run, `status` is `incomplete`; the findings present are real, but their absence
  elsewhere is not evidence.

**Deliberate non-goals.**

- Quartz and extended cron syntax (`L`, `W`, `#`, `?`), seconds fields and year
  fields are rejected with `cron-unsupported-syntax` or `cron-field-count`
  rather than guessed at.
- `@reboot` has no wall-clock expansion and is rejected.
- Horizon bounds are UTC instants only. Offsets and bare dates are rejected so
  that no host setting can change the window being checked.
- The tool is read-only. It never edits a crontab and has no auto-fix.
- No network access, no telemetry, no scheduler API calls.

**Platform dependency.** Time zone rules come from the IANA database in the
host's Node build. Two hosts on different tzdata releases can legitimately
disagree about a transition date for a zone whose rules changed between them.
Determinism is guaranteed for repeated runs on one host, not across tzdata
versions.

## Repository layout

- `src/` — implementation (`cron.mjs` parser, `timezone.mjs` resolution, `index.mjs` analysis)
- `bin/` — the CLI entry point
- `test/` — deterministic tests against the public API and the real CLI
- `examples/` — runnable clean and deliberately broken configurations
- `docs/` — rule catalog, limits and the determinism guarantee

## License

MIT. See [LICENSE](./LICENSE).
