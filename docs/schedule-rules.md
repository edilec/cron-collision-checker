# Schedule rule catalog

Every finding this tool emits carries one of the `ruleId` values below. Rule ids
are stable across releases; renaming one is a breaking change and is recorded in
`CHANGELOG.md`.

## Configuration format

```json
{
  "timezone": "America/New_York",
  "horizon": { "start": "2026-03-07T00:00:00Z", "end": "2026-03-10T00:00:00Z" },
  "limits": { "maxOccurrencesPerJob": 500 },
  "jobs": [
    {
      "id": "nightly-backup",
      "cron": "30 2 * * *",
      "durationMinutes": 45,
      "timezone": "Europe/Amsterdam",
      "resource": "primary-db"
    }
  ],
  "maintenanceWindows": [
    {
      "id": "db-patch",
      "start": "2026-03-08T05:00:00Z",
      "end": "2026-03-08T09:00:00Z",
      "mode": "forbid"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `timezone` | yes | IANA zone every job is interpreted in unless it overrides it |
| `horizon.start` / `horizon.end` | yes | half-open UTC window `[start, end)`, format `YYYY-MM-DDTHH:MM[:SS]Z`, years 1970-2100 |
| `limits` | no | per-run bounds; see below |
| `jobs[].id` | yes | 1-64 characters from `A-Z a-z 0-9 . _ -`, unique |
| `jobs[].cron` | yes | five-field expression or a supported `@macro` |
| `jobs[].durationMinutes` | yes | how long one run occupies, `1` to `maxDurationMinutes` |
| `jobs[].timezone` | no | per-job override of the config zone |
| `jobs[].resource` | no | name of something two jobs cannot hold at once |
| `maintenanceWindows[].mode` | no | `forbid` (default) or `expect` |

A run occupies the half-open interval `[start, start + durationMinutes)`, so a
run that ends exactly when the next begins does not overlap it.

Every level of the configuration -- the top level, `horizon`, `limits`, each
job and each maintenance window -- accepts only the keys listed here. A key
outside that set is a configuration error, not an ignored extra: a misspelled
key is evidence you meant to declare, and evaluating nothing while reporting
`pass` would turn a real failure into a green run. Each unknown key is reported
at its own pointer, and the run is `incomplete` with exit code `2`.

## Cron syntax

Supported: `*`, a value, `a-b`, `a-b/s`, `*/s`, comma lists, three-letter month
names (`JAN`-`DEC`) and weekday names (`SUN`-`SAT`), weekday `7` as Sunday, and
descending ranges that wrap (`22-2` in the hour field means 22, 23, 0, 1, 2).
Macros: `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`,
`@hourly`.

Day matching follows Vixie cron: when **both** day-of-month and day-of-week are
restricted, a day matches when **either** matches. When only one is restricted,
that field alone decides.

## Rules

### Configuration

| ruleId | Severity | Raised when |
| --- | --- | --- |
| `config-invalid` | error | the config, `limits`, or `jobs` is the wrong shape, or an unknown key appears at the top level or in `limits` |
| `config-timezone-unknown` | error | a zone name this host's IANA database does not know |
| `config-horizon-invalid` | error | a malformed instant, `end` not after `start`, or an unknown key in `horizon` |
| `config-horizon-too-long` | error | the horizon is longer than `maxHorizonDays` |
| `limits-invalid` | error | a limit is not an integer in `1..hard cap` |
| `job-invalid` | error | a job has no usable `id`, a malformed `resource`, or an unknown key |
| `job-duplicate-id` | error | two jobs share an `id` |
| `job-duration-invalid` | error | `durationMinutes` is missing or out of range |
| `maintenance-window-invalid` | error | a window has a bad id, bad instants, an unknown `mode`, or an unknown key |

### Cron parsing

| ruleId | Severity | Raised when |
| --- | --- | --- |
| `cron-syntax` | error | a field is malformed or a value is out of range |
| `cron-field-count` | error | the expression does not have exactly five fields |
| `cron-unsupported-syntax` | error | `L`, `W`, `#`, `?`, or a step on a single value |
| `cron-unsupported-macro` | error | `@reboot` or any macro with no fixed wall-clock expansion |
| `cron-too-long` | error | the expression is longer than 200 characters |
| `cron-dom-dow-or` | warning | both day fields are restricted, so the job runs on the union |
| `cron-no-occurrences` | warning | the job never fires inside the horizon |

### Daylight saving time

| ruleId | Severity | Raised when |
| --- | --- | --- |
| `dst-skipped` | error | the scheduled wall-clock time does not exist because the clock springs forward, so the run is dropped |
| `dst-ambiguous` | warning | the scheduled wall-clock time occurs twice because the clock falls back; the report analyses the **earlier** instant |
| `dst-transition-in-run` | info | a run crosses a UTC offset change, so its wall-clock end time shifts even though elapsed time does not |

`dst-skipped` and `dst-ambiguous` are grouped per job per local calendar date.
The message carries the count, the evidence carries up to five readings.

### Collisions

| ruleId | Severity | Raised when |
| --- | --- | --- |
| `job-self-overlap` | error | a job starts again before its previous run finished |
| `resource-contention` | error | two jobs declaring the same `resource` overlap |
| `job-overlap` | warning | two jobs overlap but declare no shared `resource` |
| `maintenance-window-collision` | error | a run intersects a `forbid` window |
| `maintenance-window-unused` | error | no run starts inside an `expect` window |

One finding is emitted per colliding pair, not per colliding run. The message
carries the number of overlapping run pairs; the evidence carries the first
overlap and the longest overlap.

### Bounds

| ruleId | Severity | Raised when |
| --- | --- | --- |
| `limit-jobs-exceeded` | error | the config declares more jobs than `maxJobs` |
| `limit-occurrences-exceeded` | error | one job fires more than `maxOccurrencesPerJob` times |
| `limit-total-occurrences-exceeded` | error | all jobs together exceed `maxTotalOccurrences` |
| `limit-scan-exceeded` | error | candidate readings exceeded the scan budget |
| `limit-comparisons-exceeded` | error | overlap detection exceeded `maxComparisons` |
| `limit-findings-exceeded` | error | more findings were produced than `maxFindings` |
| `input-unreadable` | error | (CLI) the config file is missing or not a regular file |
| `input-too-large` | error | (CLI) the config file is over 1 MiB |
| `input-unparsable` | error | (CLI) the config file is not valid JSON. The message carries the parser's position, line and column, never the snippet of the file the parser quotes back: V8 reports `Unexpected token 'A', "..." is not valid JSON`, which reproduces a short file in full. |
| `execution-failure` | error | (CLI) the check threw before producing a report |

Any of these makes the report `incomplete` and the exit code `2`. None of them
is ever a silent truncation: when expansion stops early, the finding names the
limit, and its suggestion says how many later jobs were never expanded at all.

## Limits

| Limit | Default | Hard cap |
| --- | ---: | ---: |
| `maxJobs` | 64 | 256 |
| `maxMaintenanceWindows` | 64 | 256 |
| `maxHorizonDays` | 31 | 366 |
| `maxOccurrencesPerJob` | 1000 | 20000 |
| `maxTotalOccurrences` | 10000 | 100000 |
| `maxDurationMinutes` | 44640 | 527040 |
| `maxFindings` | 500 | 5000 |
| `maxComparisons` | 2000000 | 20000000 |

A config may lower a limit but never raise it past its hard cap; trying raises
`limits-invalid`. The CLI additionally caps the config file at 1 MiB.

Two independent bounds keep expansion finite: the horizon is a bounded number of
calendar days, and each job stops at its occurrence cap. A schedule such as
`* * * * *` therefore stops at the cap instead of expanding 44 640 firings a
month. Candidate readings are separately budgeted at the occurrence cap plus
2880, which covers the one slop day at each edge of the horizon.

## Determinism guarantee

Running the tool twice over the same configuration on the same host produces
byte-identical stdout.

- No wall clock is read. Every instant comes from the configuration.
- No `Math.random`, no filesystem enumeration, no hash-map iteration order
  affects output.
- All string ordering uses a plain UTF-16 code unit comparator, never
  `localeCompare`, whose result varies with the ICU data a Node build carries.
- `Intl.DateTimeFormat` is pinned to the `en-US` locale, the `iso8601` calendar,
  the `latn` numbering system and the `h23` hour cycle, so only the time zone
  database influences the result.
- Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then
  `message`, then `evidence`. Pointers sort as text, so `/jobs/10` precedes
  `/jobs/2`.

Output does depend on the IANA time zone database version the host's Node build
carries. Two hosts with different tzdata releases can legitimately disagree
about a transition date for a zone whose rules changed between those releases.
