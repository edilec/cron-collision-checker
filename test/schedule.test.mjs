import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, analyzeSchedules, exitCodeFor, parseUtcInstant, serializeReport } from '../src/index.mjs'

const NEW_YORK = 'America/New_York'

function config(overrides = {}) {
  return {
    timezone: NEW_YORK,
    horizon: { start: '2026-03-07T00:00:00Z', end: '2026-03-10T00:00:00Z' },
    jobs: [{ id: 'job-a', cron: '0 2 * * *', durationMinutes: 30 }],
    ...overrides,
  }
}

function byRule(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

test('acceptance: a spring-forward gap is reported as a skipped run, not silently dropped', () => {
  const report = analyzeSchedules(config())
  const skipped = byRule(report, 'dst-skipped')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].severity, 'error')
  assert.match(skipped[0].message, /2026-03-08/)
  assert.equal(skipped[0].evidence, 'skipped: 2026-03-08 02:00')
  assert.equal(skipped[0].location.pointer, '/jobs/0/cron')
  // 07:00Z on the 7th and 06:00Z on the 9th survive; the 8th does not exist.
  assert.equal(report.summary.occurrences, 2)
  assert.equal(report.summary.dstSkipped, 1)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('acceptance: a fall-back overlap is reported as ambiguous with both instants', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-10-31T12:00:00Z', end: '2026-11-02T12:00:00Z' },
      jobs: [{ id: 'ledger', cron: '30 1 * * *', durationMinutes: 15 }],
    }),
  )
  const ambiguous = byRule(report, 'dst-ambiguous')
  assert.equal(ambiguous.length, 1)
  assert.equal(ambiguous[0].severity, 'warning')
  assert.match(ambiguous[0].evidence, /2026-11-01T05:30:00Z \(-04:00\)/)
  assert.match(ambiguous[0].evidence, /2026-11-01T06:30:00Z \(-05:00\)/)
  assert.match(ambiguous[0].evidence, /analyses the earlier instant/)
  assert.equal(report.summary.dstAmbiguous, 1)
  // Ambiguity alone is a warning, so the run still passes policy.
  assert.equal(report.status, 'pass')
  assert.equal(exitCodeFor(report), 0)
})

test('acceptance: a run whose wall clock crosses a transition is reported with real elapsed time', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' },
      jobs: [{ id: 'long-run', cron: '30 1 * * *', durationMinutes: 90 }],
    }),
  )
  const spanning = byRule(report, 'dst-transition-in-run')
  assert.equal(spanning.length, 1)
  assert.equal(spanning[0].severity, 'info')
  // 90 minutes of elapsed time, but the wall clock only advances 30 minutes.
  assert.equal(spanning[0].evidence, 'first run 2026-11-01 01:30 -04:00 for 90 minutes ends 2026-11-01 02:00 -05:00')
})

test('an ordinary run is not mistaken for one that crosses a transition', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-03T00:00:00Z' },
      jobs: [{ id: 'quiet', cron: '30 2 * * *', durationMinutes: 45 }],
    }),
  )
  assert.deepEqual(byRule(report, 'dst-transition-in-run'), [])
  assert.equal(report.status, 'pass')
})

test('acceptance: a job spanning midnight collides with the next morning job', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-04T00:00:00Z' },
      jobs: [
        { id: 'evening-load', cron: '45 23 * * *', durationMinutes: 90, resource: 'etl' },
        { id: 'early-bird', cron: '15 0 * * *', durationMinutes: 30, resource: 'etl' },
      ],
    }),
  )
  const contention = byRule(report, 'resource-contention')
  assert.equal(contention.length, 1)
  assert.equal(contention[0].severity, 'error')
  assert.match(contention[0].message, /both hold resource "etl"/)
  // The horizon opens at midnight UTC, which is already 20:00 on 31 May in New
  // York, so the first evening run is 23:45 -04:00 on 31 May = 03:45Z on 1 June,
  // and it is still running when 00:15 -04:00 = 04:15Z starts the early job.
  assert.match(contention[0].evidence, /^first overlap 2026-06-01T04:15:00Z \.\. 2026-06-01T04:45:00Z/)
  assert.match(contention[0].evidence, /longest overlap 30 minute\(s\)/)
  assert.equal(report.status, 'fail')
})

test('overlap without a declared shared resource is only a warning', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-04T00:00:00Z' },
      jobs: [
        { id: 'evening-load', cron: '45 23 * * *', durationMinutes: 90 },
        { id: 'early-bird', cron: '15 0 * * *', durationMinutes: 30 },
      ],
    }),
  )
  const overlap = byRule(report, 'job-overlap')
  assert.equal(overlap.length, 1)
  assert.equal(overlap[0].severity, 'warning')
  assert.match(overlap[0].message, /cannot say whether that is a conflict/)
  assert.equal(report.status, 'pass')
})

test('a job that outlives its own interval is reported as a self overlap', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-01T06:00:00Z' },
      jobs: [{ id: 'slow', cron: '0 * * * *', durationMinutes: 95 }],
    }),
  )
  const self = byRule(report, 'job-self-overlap')
  assert.equal(self.length, 1)
  assert.equal(self[0].severity, 'error')
  assert.match(self[0].message, /overlaps its own previous run/)
  assert.match(self[0].evidence, /longest overlap 35 minute\(s\)/)
})

test('back-to-back runs of the same job do not count as overlapping', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-01T06:00:00Z' },
      jobs: [{ id: 'tight', cron: '0 * * * *', durationMinutes: 60 }],
    }),
  )
  assert.deepEqual(byRule(report, 'job-self-overlap'), [])
  assert.equal(report.summary.collisions, 0)
})

test('maintenance windows catch both intrusion and an unused reserved slot', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-03T00:00:00Z' },
      jobs: [{ id: 'backup', cron: '30 2 * * *', durationMinutes: 45 }],
      maintenanceWindows: [
        { id: 'freeze', start: '2026-06-01T07:00:00Z', end: '2026-06-01T08:00:00Z', mode: 'forbid' },
        { id: 'reserved', start: '2026-06-02T20:00:00Z', end: '2026-06-02T21:00:00Z', mode: 'expect' },
      ],
    }),
  )
  const collision = byRule(report, 'maintenance-window-collision')
  assert.equal(collision.length, 1)
  assert.equal(collision[0].location.pointer, '/maintenanceWindows/0')
  assert.match(collision[0].evidence, /first colliding run 2026-06-01T06:30:00Z \.\. 2026-06-01T07:15:00Z/)

  const unused = byRule(report, 'maintenance-window-unused')
  assert.equal(unused.length, 1)
  assert.equal(unused[0].location.pointer, '/maintenanceWindows/1')
  assert.equal(report.summary.maintenanceWindows, 2)
})

test('acceptance: an unbounded schedule stops at its occurrence bound instead of exhausting the process', () => {
  const started = process.hrtime.bigint()
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' },
      jobs: [{ id: 'runaway', cron: '* * * * *', durationMinutes: 1 }],
    }),
  )
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  // 31 days of "* * * * *" is 44 640 firings; the default bound stops at 1 000.
  assert.equal(report.summary.occurrences, DEFAULT_LIMITS.maxOccurrencesPerJob)
  const limit = byRule(report, 'limit-occurrences-exceeded')
  assert.equal(limit.length, 1)
  assert.equal(limit[0].severity, 'error')
  assert.match(limit[0].message, /maxOccurrencesPerJob limit of 1000/)
  assert.equal(report.status, 'incomplete', 'a truncated expansion is never a pass')
  assert.equal(exitCodeFor(report), 2)
  assert.ok(elapsedMs < 15000, `bounded expansion took ${elapsedMs.toFixed(0)}ms`)
})

test('the total occurrence bound stops expansion across jobs', () => {
  const report = analyzeSchedules(
    config({
      timezone: 'UTC',
      // 30 hours, so each hourly job fires exactly 30 times and stays under its
      // own per-job cap; only the shared total budget can stop the run.
      horizon: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T06:00:00Z' },
      limits: { maxOccurrencesPerJob: 50, maxTotalOccurrences: 60 },
      jobs: [
        { id: 'first', cron: '0 * * * *', durationMinutes: 1 },
        { id: 'second', cron: '0 * * * *', durationMinutes: 1 },
        { id: 'third', cron: '0 * * * *', durationMinutes: 1 },
      ],
    }),
  )
  assert.equal(report.summary.occurrences, 60)
  assert.equal(report.summary.checked, 2, 'the third job is never reached')
  assert.deepEqual(byRule(report, 'limit-occurrences-exceeded'), [])
  const total = byRule(report, 'limit-total-occurrences-exceeded')
  assert.equal(total.length, 1)
  assert.equal(total[0].location.pointer, '/jobs/2')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('stopping early names how many jobs were never expanded', () => {
  const report = analyzeSchedules(
    config({
      timezone: 'UTC',
      horizon: { start: '2026-01-01T00:00:00Z', end: '2026-01-08T00:00:00Z' },
      limits: { maxOccurrencesPerJob: 50, maxTotalOccurrences: 60 },
      jobs: [
        { id: 'runaway', cron: '* * * * *', durationMinutes: 1 },
        { id: 'never-reached', cron: '0 3 * * *', durationMinutes: 1 },
        { id: 'also-never-reached', cron: '0 4 * * *', durationMinutes: 1 },
      ],
    }),
  )
  const limit = byRule(report, 'limit-occurrences-exceeded')
  assert.equal(limit.length, 1)
  assert.match(limit[0].suggestion, /2 later job\(s\) were not expanded at all\./)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.jobs, 3)
  assert.equal(report.status, 'incomplete')
})

test('the comparison bound truncates the overlap sweep as incomplete, never as a completed failure', () => {
  const report = analyzeSchedules(
    config({
      timezone: 'UTC',
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-01T06:00:00Z' },
      // Every run is still going when the next five start, so the sweep needs
      // far more than one comparison before it can report anything.
      limits: { maxComparisons: 1 },
      jobs: [{ id: 'slow', cron: '0 * * * *', durationMinutes: 300 }],
    }),
  )
  const limit = byRule(report, 'limit-comparisons-exceeded')
  assert.equal(limit.length, 1)
  assert.equal(limit[0].severity, 'error')
  assert.match(limit[0].message, /maxComparisons limit of 1/)
  assert.equal(report.status, 'incomplete', 'a truncated overlap sweep is never a completed failure')
  assert.equal(exitCodeFor(report), 2)
})

test('a complete overlap sweep stays a plain failure', () => {
  const report = analyzeSchedules(
    config({
      timezone: 'UTC',
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-01T06:00:00Z' },
      jobs: [{ id: 'slow', cron: '0 * * * *', durationMinutes: 300 }],
    }),
  )
  assert.deepEqual(byRule(report, 'limit-comparisons-exceeded'), [])
  assert.equal(byRule(report, 'job-self-overlap').length, 1)
  assert.equal(report.status, 'fail')
  assert.equal(exitCodeFor(report), 1)
})

test('a config cannot raise a limit past its hard cap', () => {
  const report = analyzeSchedules(config({ limits: { maxOccurrencesPerJob: 999999 } }))
  const invalid = byRule(report, 'limits-invalid')
  assert.equal(invalid.length, 1)
  assert.equal(invalid[0].location.pointer, '/limits/maxOccurrencesPerJob')
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('invalid input is reported as incomplete, never as a pass', () => {
  const cases = [
    [config({ timezone: 'Mars/Olympus' }), 'config-timezone-unknown'],
    [config({ timezone: undefined }), 'config-timezone-unknown'],
    [config({ horizon: { start: '2026-03-10T00:00:00Z', end: '2026-03-07T00:00:00Z' } }), 'config-horizon-invalid'],
    [config({ horizon: { start: '2026-02-30T00:00:00Z', end: '2026-03-07T00:00:00Z' } }), 'config-horizon-invalid'],
    [config({ horizon: { start: '2026-03-07', end: '2026-03-10' } }), 'config-horizon-invalid'],
    [config({ horizon: { start: '2026-01-01T00:00:00Z', end: '2026-06-01T00:00:00Z' } }), 'config-horizon-too-long'],
    [config({ jobs: [] }), 'config-invalid'],
    [config({ jobs: [{ id: 'a', cron: '0 2 * * *' }] }), 'job-duration-invalid'],
    [config({ jobs: [{ id: 'a', cron: '0 2 * * *', durationMinutes: 0 }] }), 'job-duration-invalid'],
    [config({ jobs: [{ id: 'a', cron: '0 0 L * *', durationMinutes: 5 }] }), 'cron-unsupported-syntax'],
    [config({ jobs: [{ id: 'bad id', cron: '0 2 * * *', durationMinutes: 5 }] }), 'job-invalid'],
    [
      config({
        jobs: [
          { id: 'same', cron: '0 2 * * *', durationMinutes: 5 },
          { id: 'same', cron: '0 3 * * *', durationMinutes: 5 },
        ],
      }),
      'job-duplicate-id',
    ],
    [
      config({ jobs: [{ id: 'a', cron: '0 2 * * *', durationMinutes: 5, timezone: 'Nowhere/Here' }] }),
      'config-timezone-unknown',
    ],
    [
      config({ maintenanceWindows: [{ id: 'w', start: '2026-03-07T00:00:00Z', end: '2026-03-07T00:00:00Z' }] }),
      'maintenance-window-invalid',
    ],
    [
      config({
        maintenanceWindows: [{ id: 'w', start: '2026-03-07T00:00:00Z', end: '2026-03-07T01:00:00Z', mode: 'skip' }],
      }),
      'maintenance-window-invalid',
    ],
    ['not an object', 'config-invalid'],
  ]

  for (const [input, ruleId] of cases) {
    const report = analyzeSchedules(input)
    assert.equal(report.status, 'incomplete', `expected incomplete for ${ruleId}`)
    assert.equal(exitCodeFor(report), 2)
    assert.ok(
      byRule(report, ruleId).length >= 1,
      `expected a ${ruleId} finding, got ${report.findings.map((f) => f.ruleId).join(', ')}`,
    )
  }
})

test('a job that never fires in the horizon is a warning, not a silent pass', () => {
  const report = analyzeSchedules(config({ jobs: [{ id: 'new-year', cron: '0 0 1 JAN *', durationMinutes: 10 }] }))
  assert.equal(byRule(report, 'cron-no-occurrences').length, 1)
  assert.equal(report.summary.occurrences, 0)
})

test('restricting both day fields is flagged because it means OR', () => {
  const report = analyzeSchedules(config({ jobs: [{ id: 'friday13', cron: '0 2 13 * FRI', durationMinutes: 10 }] }))
  const flagged = byRule(report, 'cron-dom-dow-or')
  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].severity, 'warning')
})

test('a per-job time zone overrides the config default', () => {
  const report = analyzeSchedules(
    config({
      timezone: 'UTC',
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-02T00:00:00Z' },
      jobs: [
        { id: 'utc-job', cron: '0 6 * * *', durationMinutes: 60, resource: 'shared' },
        { id: 'ny-job', cron: '0 2 * * *', durationMinutes: 60, timezone: NEW_YORK, resource: 'shared' },
      ],
    }),
  )
  // 02:00 in New York on 1 June is 06:00Z, so the two collide despite different fields.
  const contention = byRule(report, 'resource-contention')
  assert.equal(contention.length, 1)
  assert.match(contention[0].evidence, /first overlap 2026-06-01T06:00:00Z/)
})

test('parseUtcInstant accepts only strict UTC instants', () => {
  assert.equal(parseUtcInstant('2026-03-07T00:00:00Z'), Date.UTC(2026, 2, 7))
  assert.equal(parseUtcInstant('2026-03-07T00:00Z'), Date.UTC(2026, 2, 7))
  assert.equal(parseUtcInstant('2026-02-30T00:00:00Z'), null)
  assert.equal(parseUtcInstant('2026-03-07T00:00:00+01:00'), null)
  assert.equal(parseUtcInstant('2026-03-07 00:00:00Z'), null)
  assert.equal(parseUtcInstant('1969-12-31T00:00:00Z'), null)
  assert.equal(parseUtcInstant(1772000000000), null)
})

test('the same input produces byte-identical output twice', () => {
  const input = config({
    horizon: { start: '2026-03-07T00:00:00Z', end: '2026-03-10T00:00:00Z' },
    jobs: [
      { id: 'daily-2am', cron: '0 2 * * *', durationMinutes: 30, resource: 'etl' },
      { id: 'midnight-span', cron: '45 23 * * *', durationMinutes: 90, resource: 'etl' },
      { id: 'early-bird', cron: '15 0 * * *', durationMinutes: 30, resource: 'etl' },
    ],
    maintenanceWindows: [{ id: 'freeze', start: '2026-03-09T03:30:00Z', end: '2026-03-09T05:00:00Z' }],
  })
  const first = serializeReport(analyzeSchedules(input))
  const second = serializeReport(analyzeSchedules(input))
  assert.equal(first, second)
  assert.ok(first.length > 500)
})

test('findings are ordered by file, pointer, rule id and message', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-03-07T00:00:00Z', end: '2026-03-10T00:00:00Z' },
      jobs: [
        { id: 'daily-2am', cron: '0 2 * * *', durationMinutes: 30, resource: 'etl' },
        { id: 'midnight-span', cron: '45 23 * * *', durationMinutes: 90, resource: 'etl' },
        { id: 'early-bird', cron: '15 0 * * *', durationMinutes: 30, resource: 'etl' },
      ],
      maintenanceWindows: [{ id: 'freeze', start: '2026-03-09T03:30:00Z', end: '2026-03-09T05:00:00Z' }],
    }),
    { configLabel: 'schedules.json' },
  )
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  const keyOf = (finding) => [
    finding.location.file,
    finding.location.pointer ?? '',
    finding.ruleId,
    finding.message,
  ]
  for (let index = 1; index < report.findings.length; index += 1) {
    const previous = keyOf(report.findings[index - 1])
    const current = keyOf(report.findings[index])
    const order =
      compare(previous[0], current[0]) ||
      compare(previous[1], current[1]) ||
      compare(previous[2], current[2]) ||
      compare(previous[3], current[3])
    assert.ok(order <= 0, `finding ${index} is out of order: ${current.join(' ')}`)
  }
  assert.ok(report.findings.length >= 4)
  for (const finding of report.findings) assert.equal(finding.location.file, 'schedules.json')
})

test('evidence stays bounded', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-03-08T00:00:00Z', end: '2026-03-09T00:00:00Z' },
      limits: { maxOccurrencesPerJob: 200 },
      jobs: [{ id: 'gap-storm', cron: '* 2 * * *', durationMinutes: 1 }],
    }),
  )
  const skipped = byRule(report, 'dst-skipped')
  assert.equal(skipped.length, 1, 'the whole gap is one grouped finding')
  assert.ok(skipped[0].evidence.length <= 240)
  assert.match(skipped[0].evidence, /\(\+55 more\)$/)
  assert.match(skipped[0].message, /60 wall-clock time\(s\)/)
})

test('the findings bound truncates explicitly rather than silently', () => {
  const report = analyzeSchedules(
    config({
      horizon: { start: '2026-06-01T00:00:00Z', end: '2026-06-08T00:00:00Z' },
      limits: { maxFindings: 3, maxOccurrencesPerJob: 400 },
      jobs: [
        { id: 'a', cron: '0 * * * *', durationMinutes: 95 },
        { id: 'b', cron: '30 * * * *', durationMinutes: 95 },
        { id: 'c', cron: '15 * * * *', durationMinutes: 95 },
        { id: 'd', cron: '45 * * * *', durationMinutes: 95 },
      ],
    }),
  )
  assert.equal(report.findings.length, 3)
  assert.equal(byRule(report, 'limit-findings-exceeded').length, 1)
  assert.equal(report.status, 'incomplete')
})
