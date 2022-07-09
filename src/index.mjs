/**
 * cron-collision-checker - expand five-field cron schedules over a bounded
 * horizon in an explicit time zone, then report overlaps, DST hazards and
 * maintenance-window violations.
 *
 * Everything here is pure: no clock, no locale-sensitive comparison, no network,
 * no filesystem enumeration. The same config object always yields the same
 * report on a host carrying the same IANA time zone database.
 */

import { CronSyntaxError, matchesDate, parseCron } from './cron.mjs'
import {
  civilFromDays,
  dayOfWeekFromDays,
  daysFromCivil,
  describeLocal,
  fieldsAt,
  fieldsFromLocalMs,
  formatInstant,
  formatOffset,
  formatWallClock,
  instantsForLocalMs,
  isKnownTimeZone,
  localMsFromFields,
  nominalInstantForLocalMs,
  offsetMsAt,
} from './timezone.mjs'

export { CronSyntaxError, parseCron } from './cron.mjs'

export const SCHEMA_VERSION = '1'
export const TOOL_ID = 'cron-collision-checker'

/** Defaults chosen so that an unbounded schedule stops long before it hurts. */
export const DEFAULT_LIMITS = Object.freeze({
  maxJobs: 64,
  maxMaintenanceWindows: 64,
  maxHorizonDays: 31,
  maxOccurrencesPerJob: 1000,
  maxTotalOccurrences: 10000,
  maxDurationMinutes: 44640,
  maxFindings: 500,
  maxComparisons: 2000000,
})

/** A config may lower a limit but never raise it past these caps. */
export const HARD_LIMITS = Object.freeze({
  maxJobs: 256,
  maxMaintenanceWindows: 256,
  maxHorizonDays: 366,
  maxOccurrencesPerJob: 20000,
  maxTotalOccurrences: 100000,
  maxDurationMinutes: 527040,
  maxFindings: 5000,
  maxComparisons: 20000000,
})

const MS_PER_MINUTE = 60000
const MS_PER_DAY = 86400000
const EDGE_SLOP_CANDIDATES = 2880
const MAX_EVIDENCE_CHARS = 240
const MAX_EVIDENCE_ITEMS = 5
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function clampEvidence(text) {
  const value = String(text)
  return value.length <= MAX_EVIDENCE_CHARS ? value : `${value.slice(0, MAX_EVIDENCE_CHARS - 3)}...`
}

/**
 * Parse a strict UTC instant. Only `YYYY-MM-DDTHH:MM[:SS]Z` is accepted so that
 * no host offset or locale can influence the result. Returns null on rejection.
 */
export function parseUtcInstant(value) {
  const match = INSTANT_PATTERN.exec(typeof value === 'string' ? value : '')
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  if (year < 1970 || year > 2100) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const ms = localMsFromFields(year, month, day, hour, minute, second)
  const back = fieldsFromLocalMs(ms)
  if (back.year !== year || back.month !== month || back.day !== day) return null
  return ms
}

class FindingSink {
  constructor(file) {
    this.file = file
    this.items = []
  }

  add(ruleId, severity, message, extra = {}) {
    const location = { file: this.file }
    if (extra.pointer !== undefined) location.pointer = extra.pointer
    const finding = { ruleId, severity, message, location }
    if (extra.evidence !== undefined) finding.evidence = clampEvidence(extra.evidence)
    if (extra.suggestion !== undefined) finding.suggestion = extra.suggestion
    this.items.push(finding)
    return finding
  }
}

/** Documented sort key: location.file, location.pointer, ruleId, message, evidence. */
function compareFindings(a, b) {
  return (
    compareText(a.location.file, b.location.file) ||
    compareText(a.location.pointer ?? '', b.location.pointer ?? '') ||
    compareText(a.ruleId, b.ruleId) ||
    compareText(a.message, b.message) ||
    compareText(a.evidence ?? '', b.evidence ?? '')
  )
}

function finishReport(sink, { incomplete, limits, extras }) {
  let findings = [...sink.items].sort(compareFindings)
  let truncated = false
  if (findings.length > limits.maxFindings) {
    const dropped = findings.length - limits.maxFindings + 1
    findings = findings.slice(0, limits.maxFindings - 1)
    findings.push(
      sink.add(
        'limit-findings-exceeded',
        'error',
        `report produced more findings than the configured maxFindings limit of ${limits.maxFindings}`,
        {
          evidence: `${dropped} finding(s) were not reported`,
          suggestion: 'Raise limits.maxFindings or narrow the horizon, then re-run; this report is partial.',
        },
      ),
    )
    findings.sort(compareFindings)
    truncated = true
  }

  let errors = 0
  let warnings = 0
  for (const finding of findings) {
    if (finding.severity === 'error') errors += 1
    else if (finding.severity === 'warning') warnings += 1
  }

  const status = incomplete || truncated ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: { checked: extras.checked, errors, warnings, ...extras.counts },
    findings,
  }
}

function emptyCounts() {
  return {
    jobs: 0,
    occurrences: 0,
    collisions: 0,
    maintenanceWindows: 0,
    dstSkipped: 0,
    dstAmbiguous: 0,
  }
}

/**
 * Every key the schema defines, per configuration level. A key outside these
 * lists is rejected rather than ignored: a misspelled key is evidence the user
 * meant to declare, and silently dropping it turns a real failure into a pass.
 */
const CONFIG_KEYS = ['timezone', 'horizon', 'limits', 'jobs', 'maintenanceWindows']
const HORIZON_KEYS = ['start', 'end']
const JOB_KEYS = ['id', 'cron', 'durationMinutes', 'timezone', 'resource']
const MAINTENANCE_WINDOW_KEYS = ['id', 'start', 'end', 'mode']

/**
 * Report every key at one level that the schema does not define.
 *
 * @returns {boolean} true when at least one unknown key was reported, which
 *   makes the configuration invalid exactly as an unknown limit does.
 */
function rejectUnknownKeys(raw, allowed, basePointer, ruleId, subject, sink) {
  const unknown = Object.keys(raw)
    .filter((key) => !allowed.includes(key))
    .sort(compareText)
  for (const key of unknown) {
    sink.add(ruleId, 'error', `${subject} has unknown key "${key}"`, {
      pointer: `${basePointer}/${key}`,
      evidence: `known keys: ${allowed.join(', ')}`,
      suggestion: 'Correct the spelling or remove the key; an ignored key would check nothing at all.',
    })
  }
  return unknown.length > 0
}

function resolveLimits(raw, sink) {
  const limits = { ...DEFAULT_LIMITS }
  if (raw === undefined) return limits
  if (!isPlainObject(raw)) {
    sink.add('config-invalid', 'error', '"limits" must be an object', { pointer: '/limits' })
    return null
  }
  for (const key of Object.keys(raw).sort(compareText)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      sink.add('config-invalid', 'error', `unknown limit "${key}"`, { pointer: `/limits/${key}` })
      return null
    }
    const value = raw[key]
    const cap = HARD_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > cap) {
      sink.add(
        'limits-invalid',
        'error',
        `limit "${key}" must be an integer between 1 and ${cap}`,
        { pointer: `/limits/${key}`, evidence: `received ${JSON.stringify(value)}` },
      )
      return null
    }
    limits[key] = value
  }
  return limits
}

function validateHorizon(raw, limits, sink) {
  if (!isPlainObject(raw)) {
    sink.add('config-horizon-invalid', 'error', '"horizon" must be an object with "start" and "end"', {
      pointer: '/horizon',
    })
    return null
  }
  if (rejectUnknownKeys(raw, HORIZON_KEYS, '/horizon', 'config-horizon-invalid', '"horizon"', sink)) return null
  const start = parseUtcInstant(raw.start)
  const end = parseUtcInstant(raw.end)
  if (start === null) {
    sink.add(
      'config-horizon-invalid',
      'error',
      'horizon.start must be a UTC instant formatted YYYY-MM-DDTHH:MM[:SS]Z between 1970 and 2100',
      { pointer: '/horizon/start', evidence: `received ${JSON.stringify(raw.start)}` },
    )
    return null
  }
  if (end === null) {
    sink.add(
      'config-horizon-invalid',
      'error',
      'horizon.end must be a UTC instant formatted YYYY-MM-DDTHH:MM[:SS]Z between 1970 and 2100',
      { pointer: '/horizon/end', evidence: `received ${JSON.stringify(raw.end)}` },
    )
    return null
  }
  if (end <= start) {
    sink.add('config-horizon-invalid', 'error', 'horizon.end must be strictly after horizon.start', {
      pointer: '/horizon',
    })
    return null
  }
  const days = (end - start) / MS_PER_DAY
  if (days > limits.maxHorizonDays) {
    sink.add(
      'config-horizon-too-long',
      'error',
      `horizon spans ${days.toFixed(2)} days; the configured maxHorizonDays limit is ${limits.maxHorizonDays}`,
      {
        pointer: '/horizon',
        suggestion: 'Shorten the horizon or raise limits.maxHorizonDays up to its hard cap.',
      },
    )
    return null
  }
  return { start, end }
}

function validateJobs(raw, defaultTimeZone, limits, sink) {
  if (!Array.isArray(raw) || raw.length === 0) {
    sink.add('config-invalid', 'error', '"jobs" must be a non-empty array', { pointer: '/jobs' })
    return null
  }
  if (raw.length > limits.maxJobs) {
    sink.add(
      'limit-jobs-exceeded',
      'error',
      `config declares ${raw.length} jobs; the configured maxJobs limit is ${limits.maxJobs}`,
      { pointer: '/jobs' },
    )
    return null
  }

  const jobs = []
  const seen = new Set()
  let rejected = false

  for (let index = 0; index < raw.length; index += 1) {
    const pointer = `/jobs/${index}`
    const entry = raw[index]
    if (!isPlainObject(entry)) {
      sink.add('job-invalid', 'error', `job at index ${index} must be an object`, { pointer })
      rejected = true
      continue
    }
    if (rejectUnknownKeys(entry, JOB_KEYS, pointer, 'job-invalid', `job at index ${index}`, sink)) {
      rejected = true
      continue
    }
    if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
      sink.add(
        'job-invalid',
        'error',
        `job at index ${index} needs an "id" of 1-64 characters from A-Z a-z 0-9 . _ -`,
        { pointer: `${pointer}/id`, evidence: `received ${JSON.stringify(entry.id)}` },
      )
      rejected = true
      continue
    }
    if (seen.has(entry.id)) {
      sink.add('job-duplicate-id', 'error', `job id "${entry.id}" is used more than once`, {
        pointer: `${pointer}/id`,
        suggestion: 'Give every job a unique id so findings can be attributed.',
      })
      rejected = true
      continue
    }
    if (
      !Number.isInteger(entry.durationMinutes) ||
      entry.durationMinutes < 1 ||
      entry.durationMinutes > limits.maxDurationMinutes
    ) {
      sink.add(
        'job-duration-invalid',
        'error',
        `job "${entry.id}" needs an explicit integer "durationMinutes" between 1 and ${limits.maxDurationMinutes}`,
        { pointer: `${pointer}/durationMinutes`, evidence: `received ${JSON.stringify(entry.durationMinutes)}` },
      )
      rejected = true
      continue
    }
    const timeZone = entry.timezone === undefined ? defaultTimeZone : entry.timezone
    if (!isKnownTimeZone(timeZone)) {
      sink.add(
        'config-timezone-unknown',
        'error',
        `job "${entry.id}" names time zone ${JSON.stringify(timeZone)}, which this host's IANA database does not know`,
        { pointer: `${pointer}/timezone` },
      )
      rejected = true
      continue
    }
    if (entry.resource !== undefined && (typeof entry.resource !== 'string' || !ID_PATTERN.test(entry.resource))) {
      sink.add(
        'job-invalid',
        'error',
        `job "${entry.id}" has a "resource" that is not a 1-64 character identifier`,
        { pointer: `${pointer}/resource`, evidence: `received ${JSON.stringify(entry.resource)}` },
      )
      rejected = true
      continue
    }

    let spec
    try {
      spec = parseCron(entry.cron)
    } catch (error) {
      if (!(error instanceof CronSyntaxError)) throw error
      sink.add(error.ruleId, 'error', `job "${entry.id}": ${error.message}`, {
        pointer: `${pointer}/cron`,
        evidence: `cron ${JSON.stringify(entry.cron)}`,
      })
      rejected = true
      continue
    }

    if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) {
      sink.add(
        'cron-dom-dow-or',
        'warning',
        `job "${entry.id}" restricts both day-of-month and day-of-week, so it runs when EITHER matches`,
        {
          pointer: `${pointer}/cron`,
          evidence: `cron ${JSON.stringify(spec.expression)}`,
          suggestion: 'Leave one of the two day fields as "*" unless the union is intended.',
        },
      )
    }

    seen.add(entry.id)
    jobs.push({
      index,
      pointer,
      id: entry.id,
      cron: spec.expression,
      spec,
      timeZone,
      durationMs: entry.durationMinutes * MS_PER_MINUTE,
      durationMinutes: entry.durationMinutes,
      resource: typeof entry.resource === 'string' ? entry.resource : null,
    })
  }

  return { jobs, rejected }
}

function validateMaintenanceWindows(raw, limits, sink) {
  if (raw === undefined) return { windows: [], rejected: false }
  if (!Array.isArray(raw)) {
    sink.add('maintenance-window-invalid', 'error', '"maintenanceWindows" must be an array', {
      pointer: '/maintenanceWindows',
    })
    return null
  }
  if (raw.length > limits.maxMaintenanceWindows) {
    sink.add(
      'maintenance-window-invalid',
      'error',
      `config declares ${raw.length} maintenance windows; the configured maxMaintenanceWindows limit is ${limits.maxMaintenanceWindows}`,
      { pointer: '/maintenanceWindows' },
    )
    return null
  }

  const windows = []
  const seen = new Set()
  let rejected = false

  for (let index = 0; index < raw.length; index += 1) {
    const pointer = `/maintenanceWindows/${index}`
    const entry = raw[index]
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) || seen.has(entry.id)) {
      sink.add(
        'maintenance-window-invalid',
        'error',
        `maintenance window at index ${index} needs a unique "id" of 1-64 identifier characters`,
        { pointer },
      )
      rejected = true
      continue
    }
    if (
      rejectUnknownKeys(
        entry,
        MAINTENANCE_WINDOW_KEYS,
        pointer,
        'maintenance-window-invalid',
        `maintenance window "${entry.id}"`,
        sink,
      )
    ) {
      rejected = true
      continue
    }
    const start = parseUtcInstant(entry.start)
    const end = parseUtcInstant(entry.end)
    if (start === null || end === null || end <= start) {
      sink.add(
        'maintenance-window-invalid',
        'error',
        `maintenance window "${entry.id}" needs UTC "start" and "end" instants with end after start`,
        { pointer, evidence: `received ${JSON.stringify(entry.start)} .. ${JSON.stringify(entry.end)}` },
      )
      rejected = true
      continue
    }
    const mode = entry.mode === undefined ? 'forbid' : entry.mode
    if (mode !== 'forbid' && mode !== 'expect') {
      sink.add(
        'maintenance-window-invalid',
        'error',
        `maintenance window "${entry.id}" has mode ${JSON.stringify(entry.mode)}; expected "forbid" or "expect"`,
        { pointer: `${pointer}/mode` },
      )
      rejected = true
      continue
    }
    seen.add(entry.id)
    windows.push({ index, pointer, id: entry.id, start, end, mode })
  }

  return { windows, rejected }
}

/**
 * Walk the matching wall-clock readings for one job. The walk is bounded twice
 * over: by the calendar days the horizon covers and by `occurrenceCap`, so a
 * schedule such as "* * * * *" stops at the cap instead of running away.
 */
function expandJob(job, windowStart, windowEnd, occurrenceCap) {
  const { spec, timeZone } = job
  const startFields = fieldsAt(timeZone, windowStart)
  const endFields = fieldsAt(timeZone, windowEnd)
  const firstDay = daysFromCivil(startFields.year, startFields.month, startFields.day) - 1
  const lastDay = daysFromCivil(endFields.year, endFields.month, endFields.day) + 1
  const scanCap = occurrenceCap + EDGE_SLOP_CANDIDATES

  const occurrences = []
  const skipped = []
  const ambiguous = []
  let scanned = 0
  let limitHit = null

  walk: for (let day = firstDay; day <= lastDay; day += 1) {
    const civil = civilFromDays(day)
    if (!matchesDate(spec, civil.month, civil.day, dayOfWeekFromDays(day))) continue
    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        scanned += 1
        if (scanned > scanCap) {
          limitHit = 'scan'
          break walk
        }
        const localMs = (day * 1440 + hour * 60 + minute) * MS_PER_MINUTE
        const instants = instantsForLocalMs(timeZone, localMs)
        if (instants.length === 0) {
          const nominal = nominalInstantForLocalMs(timeZone, localMs)
          if (nominal >= windowStart && nominal < windowEnd) skipped.push({ localMs })
          continue
        }
        const instant = instants[0]
        if (instant < windowStart || instant >= windowEnd) continue
        if (occurrences.length >= occurrenceCap) {
          limitHit = 'occurrences'
          break walk
        }
        if (instants.length > 1) ambiguous.push({ localMs, first: instants[0], second: instants[1] })
        occurrences.push({ localMs, instant, end: instant + job.durationMs })
      }
    }
  }

  occurrences.sort((a, b) => a.instant - b.instant || a.end - b.end)
  return { occurrences, skipped, ambiguous, scanned, limitHit }
}

function localDateKey(localMs) {
  return formatWallClock(localMs).slice(0, 10)
}

function groupByLocalDate(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const key = localDateKey(entry.localMs)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [entry])
    else bucket.push(entry)
  }
  return [...groups.entries()].sort((a, b) => compareText(a[0], b[0]))
}

function reportDstFindings(job, expansion, sink, counts) {
  counts.dstSkipped += expansion.skipped.length
  counts.dstAmbiguous += expansion.ambiguous.length

  for (const [date, entries] of groupByLocalDate(expansion.skipped)) {
    const sample = entries.slice(0, MAX_EVIDENCE_ITEMS).map((entry) => formatWallClock(entry.localMs))
    sink.add(
      'dst-skipped',
      'error',
      `job "${job.id}" is scheduled for ${entries.length} wall-clock time(s) on ${date} that do not exist in ${job.timeZone} because the clock springs forward`,
      {
        pointer: `${job.pointer}/cron`,
        evidence: `skipped: ${sample.join(', ')}${entries.length > sample.length ? ` (+${entries.length - sample.length} more)` : ''}`,
        suggestion: 'Move the schedule outside the spring-forward gap, or accept that the run is dropped that day.',
      },
    )
  }

  for (const [date, entries] of groupByLocalDate(expansion.ambiguous)) {
    const first = entries[0]
    sink.add(
      'dst-ambiguous',
      'warning',
      `job "${job.id}" is scheduled for ${entries.length} wall-clock time(s) on ${date} that occur twice in ${job.timeZone} because the clock falls back`,
      {
        pointer: `${job.pointer}/cron`,
        evidence: `${formatWallClock(first.localMs)} maps to ${formatInstant(first.first)} (${formatOffset(offsetMsAt(job.timeZone, first.first))}) and ${formatInstant(first.second)} (${formatOffset(offsetMsAt(job.timeZone, first.second))}); this report analyses the earlier instant`,
        suggestion: 'Confirm whether your scheduler fires once or twice across the fall-back overlap.',
      },
    )
  }

  const spanning = []
  for (const occurrence of expansion.occurrences) {
    const startOffset = offsetMsAt(job.timeZone, occurrence.instant)
    const endOffset = offsetMsAt(job.timeZone, occurrence.end - 1)
    if (startOffset !== endOffset) spanning.push(occurrence)
  }
  for (const [date, entries] of groupByLocalDate(spanning)) {
    sink.add(
      'dst-transition-in-run',
      'info',
      `job "${job.id}" has ${entries.length} run(s) starting on ${date} that cross a UTC offset change in ${job.timeZone}`,
      {
        pointer: `${job.pointer}/durationMinutes`,
        evidence: `first run ${describeLocal(job.timeZone, entries[0].instant)} for ${job.durationMinutes} minutes ends ${describeLocal(job.timeZone, entries[0].end)}`,
        suggestion: 'Elapsed time is unchanged, but the wall-clock end time shifts by the transition amount.',
      },
    )
  }
}

function pairKey(a, b) {
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * Sweep the chronological intervals and report every colliding pair.
 *
 * @returns {boolean} true when the comparison budget stopped the sweep early,
 *   which makes the overlap analysis partial and the whole report incomplete.
 */
function detectCollisions(jobs, intervals, limits, sink, counts) {
  const pairs = new Map()
  let active = []
  let comparisons = 0
  let limitHit = false

  sweep: for (const interval of intervals) {
    const next = []
    for (const other of active) {
      if (other.end <= interval.start) continue
      next.push(other)
      comparisons += 1
      if (comparisons > limits.maxComparisons) {
        limitHit = true
        active = next
        break sweep
      }
      const overlapEnd = Math.min(other.end, interval.end)
      if (overlapEnd <= interval.start) continue
      const key = pairKey(other.jobIndex, interval.jobIndex)
      let pair = pairs.get(key)
      if (pair === undefined) {
        pair = {
          key,
          a: other.jobIndex <= interval.jobIndex ? other : interval,
          b: other.jobIndex <= interval.jobIndex ? interval : other,
          count: 0,
          firstStart: interval.start,
          firstEnd: overlapEnd,
          maxOverlapMs: 0,
        }
        pairs.set(key, pair)
      }
      pair.count += 1
      pair.maxOverlapMs = Math.max(pair.maxOverlapMs, overlapEnd - interval.start)
    }
    next.push(interval)
    active = next
  }

  if (limitHit) {
    sink.add(
      'limit-comparisons-exceeded',
      'error',
      `overlap detection exceeded the configured maxComparisons limit of ${limits.maxComparisons}`,
      {
        pointer: '/jobs',
        suggestion: 'Narrow the horizon or lower limits.maxOccurrencesPerJob; this overlap report is partial.',
      },
    )
  }

  const ordered = [...pairs.values()].sort((left, right) => compareText(left.key, right.key))
  for (const pair of ordered) {
    counts.collisions += pair.count
    const jobA = jobs.get(pair.a.jobIndex)
    const jobB = jobs.get(pair.b.jobIndex)
    const minutes = Math.round(pair.maxOverlapMs / MS_PER_MINUTE)
    const evidence = `first overlap ${formatInstant(pair.firstStart)} .. ${formatInstant(pair.firstEnd)} (${describeLocal(jobA.timeZone, pair.firstStart)}); longest overlap ${minutes} minute(s)`

    if (jobA.index === jobB.index) {
      sink.add(
        'job-self-overlap',
        'error',
        `job "${jobA.id}" overlaps its own previous run ${pair.count} time(s): a ${jobA.durationMinutes} minute run does not finish before the next fire`,
        {
          pointer: `${jobA.pointer}/durationMinutes`,
          evidence,
          suggestion: 'Shorten the run, widen the cron interval, or add a lock so concurrent runs cannot start.',
        },
      )
      continue
    }

    const shared = jobA.resource !== null && jobA.resource === jobB.resource
    sink.add(
      shared ? 'resource-contention' : 'job-overlap',
      shared ? 'error' : 'warning',
      shared
        ? `jobs "${jobA.id}" and "${jobB.id}" both hold resource "${jobA.resource}" and overlap ${pair.count} time(s)`
        : `jobs "${jobA.id}" and "${jobB.id}" overlap ${pair.count} time(s); no shared resource is declared, so this tool cannot say whether that is a conflict`,
      {
        pointer: jobA.pointer,
        evidence,
        suggestion: shared
          ? 'Stagger the schedules or serialise access to the resource.'
          : 'Declare a "resource" on both jobs if they contend, so overlap is reported as an error.',
      },
    )
  }

  return limitHit
}

function checkMaintenanceWindows(jobs, intervals, windows, sink, counts) {
  counts.maintenanceWindows = windows.length
  for (const window of windows) {
    const hits = new Map()
    let insideStarts = 0
    for (const interval of intervals) {
      if (interval.start < window.end && interval.end > window.start) {
        const bucket = hits.get(interval.jobIndex)
        if (bucket === undefined) hits.set(interval.jobIndex, { count: 1, first: interval })
        else bucket.count += 1
      }
      if (interval.start >= window.start && interval.start < window.end) insideStarts += 1
    }

    if (window.mode === 'expect') {
      if (insideStarts === 0) {
        sink.add(
          'maintenance-window-unused',
          'error',
          `maintenance window "${window.id}" expects at least one job to start inside it, but no scanned run does`,
          {
            pointer: window.pointer,
            evidence: `window ${formatInstant(window.start)} .. ${formatInstant(window.end)}`,
            suggestion: 'Check the cron expression and time zone of the job meant to fill this window.',
          },
        )
      }
      continue
    }

    const ordered = [...hits.entries()].sort((a, b) => a[0] - b[0])
    for (const [jobIndex, hit] of ordered) {
      const job = jobs.get(jobIndex)
      sink.add(
        'maintenance-window-collision',
        'error',
        `job "${job.id}" runs during maintenance window "${window.id}" ${hit.count} time(s)`,
        {
          pointer: window.pointer,
          evidence: `window ${formatInstant(window.start)} .. ${formatInstant(window.end)}; first colliding run ${formatInstant(hit.first.start)} .. ${formatInstant(hit.first.end)} (${describeLocal(job.timeZone, hit.first.start)})`,
          suggestion: 'Move the schedule outside the window, or pause the job for its duration.',
        },
      )
    }
  }
}

/**
 * Expand every job over the horizon and report what collides.
 *
 * @param {object} config parsed configuration object
 * @param {{configLabel?: string, onDiagnostic?: (line: string) => void}} [options]
 * @returns {object} report envelope following the Edilec report contract v1
 */
export function analyzeSchedules(config, options = {}) {
  const file =
    typeof options.configLabel === 'string' && options.configLabel.length > 0 ? options.configLabel : 'config.json'
  const diagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {}
  const sink = new FindingSink(file)
  const counts = emptyCounts()

  if (!isPlainObject(config)) {
    sink.add('config-invalid', 'error', 'configuration must be a JSON object', { pointer: '' })
    return finishReport(sink, { incomplete: true, limits: DEFAULT_LIMITS, extras: { checked: 0, counts } })
  }

  if (rejectUnknownKeys(config, CONFIG_KEYS, '', 'config-invalid', 'configuration', sink)) {
    return finishReport(sink, { incomplete: true, limits: DEFAULT_LIMITS, extras: { checked: 0, counts } })
  }

  const limits = resolveLimits(config.limits, sink)
  if (limits === null) {
    return finishReport(sink, { incomplete: true, limits: DEFAULT_LIMITS, extras: { checked: 0, counts } })
  }

  if (!isKnownTimeZone(config.timezone)) {
    sink.add(
      'config-timezone-unknown',
      'error',
      `"timezone" must name an IANA time zone this host knows, for example "Europe/Amsterdam"`,
      { pointer: '/timezone', evidence: `received ${JSON.stringify(config.timezone)}` },
    )
    return finishReport(sink, { incomplete: true, limits, extras: { checked: 0, counts } })
  }

  const horizon = validateHorizon(config.horizon, limits, sink)
  if (horizon === null) {
    return finishReport(sink, { incomplete: true, limits, extras: { checked: 0, counts } })
  }

  const jobResult = validateJobs(config.jobs, config.timezone, limits, sink)
  if (jobResult === null) {
    return finishReport(sink, { incomplete: true, limits, extras: { checked: 0, counts } })
  }
  const windowResult = validateMaintenanceWindows(config.maintenanceWindows, limits, sink)
  if (windowResult === null) {
    return finishReport(sink, { incomplete: true, limits, extras: { checked: 0, counts } })
  }

  let incomplete = jobResult.rejected || windowResult.rejected
  const jobs = jobResult.jobs
  counts.jobs = jobs.length

  const intervals = []
  let checked = 0
  let sequence = 0

  for (let position = 0; position < jobs.length; position += 1) {
    const job = jobs[position]
    // Stopping early leaves later jobs unexpanded; every limit finding below
    // says how many, so a truncated run can never read as full coverage.
    const unexpanded = jobs.length - position - 1
    const alsoUnexpanded =
      unexpanded > 0 ? ` ${unexpanded} later job(s) were not expanded at all.` : ''
    const remaining = limits.maxTotalOccurrences - counts.occurrences
    if (remaining <= 0) {
      sink.add(
        'limit-total-occurrences-exceeded',
        'error',
        `expansion stopped at the configured maxTotalOccurrences limit of ${limits.maxTotalOccurrences} before job "${job.id}" was expanded`,
        {
          pointer: job.pointer,
          suggestion: `Narrow the horizon or raise limits.maxTotalOccurrences; this report covers only part of the config.${alsoUnexpanded}`,
        },
      )
      incomplete = true
      break
    }

    const cap = Math.min(limits.maxOccurrencesPerJob, remaining)
    const expansion = expandJob(job, horizon.start, horizon.end, cap)
    checked += 1
    counts.occurrences += expansion.occurrences.length
    diagnostic(
      `expanded job ${job.id} (${job.cron}, ${job.timeZone}): ${expansion.occurrences.length} occurrence(s) from ${expansion.scanned} candidate(s)`,
    )

    if (expansion.limitHit !== null) {
      incomplete = true
      if (expansion.limitHit === 'scan') {
        sink.add(
          'limit-scan-exceeded',
          'error',
          `job "${job.id}" needed more than ${cap + EDGE_SLOP_CANDIDATES} candidate readings before filling its occurrence budget`,
          {
            pointer: `${job.pointer}/cron`,
            suggestion: `Narrow the horizon or make the schedule less dense.${alsoUnexpanded}`,
          },
        )
      } else if (cap === limits.maxOccurrencesPerJob) {
        sink.add(
          'limit-occurrences-exceeded',
          'error',
          `job "${job.id}" fires more than the configured maxOccurrencesPerJob limit of ${limits.maxOccurrencesPerJob} inside the horizon`,
          {
            pointer: `${job.pointer}/cron`,
            evidence: `cron ${JSON.stringify(job.cron)} stopped after ${expansion.occurrences.length} occurrence(s)`,
            suggestion: `Shorten the horizon or raise limits.maxOccurrencesPerJob; this report covers only part of the schedule.${alsoUnexpanded}`,
          },
        )
      } else {
        sink.add(
          'limit-total-occurrences-exceeded',
          'error',
          `job "${job.id}" exhausted the configured maxTotalOccurrences limit of ${limits.maxTotalOccurrences}`,
          {
            pointer: `${job.pointer}/cron`,
            suggestion: `Narrow the horizon or raise limits.maxTotalOccurrences; this report covers only part of the config.${alsoUnexpanded}`,
          },
        )
      }
    } else if (expansion.occurrences.length === 0) {
      sink.add(
        'cron-no-occurrences',
        'warning',
        `job "${job.id}" never fires inside the horizon`,
        {
          pointer: `${job.pointer}/cron`,
          evidence: `cron ${JSON.stringify(job.cron)} in ${job.timeZone}`,
          suggestion: 'Widen the horizon or check the expression; an unfired job proves nothing about collisions.',
        },
      )
    }

    reportDstFindings(job, expansion, sink, counts)

    for (const occurrence of expansion.occurrences) {
      intervals.push({
        jobIndex: job.index,
        jobId: job.id,
        start: occurrence.instant,
        end: occurrence.end,
        sequence: sequence++,
      })
    }

    if (expansion.limitHit !== null) break
  }

  // One chronological order feeds both the overlap sweep and the window check,
  // so "first colliding run" means the same thing in every finding.
  intervals.sort(
    (a, b) => a.start - b.start || a.end - b.end || compareText(a.jobId, b.jobId) || a.sequence - b.sequence,
  )
  const jobsByIndex = new Map(jobs.map((job) => [job.index, job]))
  // A truncated sweep leaves pairs uncompared, so it is incomplete like every
  // other bound, never a completed failure.
  if (detectCollisions(jobsByIndex, intervals, limits, sink, counts)) incomplete = true
  checkMaintenanceWindows(jobsByIndex, intervals, windowResult.windows, sink, counts)

  return finishReport(sink, { incomplete, limits, extras: { checked, counts } })
}

export function serializeReport(report) {
  return JSON.stringify(report, null, 2)
}

export function formatReport(report) {
  const lines = [`${report.tool}: ${report.status}`]
  const summary = report.summary
  lines.push(
    `  ${summary.checked} job(s) expanded, ${summary.occurrences} occurrence(s), ${summary.collisions} overlap(s)`,
  )
  lines.push(
    `  ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.dstSkipped} DST-skipped, ${summary.dstAmbiguous} DST-ambiguous`,
  )
  for (const finding of report.findings) {
    const pointer = finding.location.pointer ? ` ${finding.location.pointer}` : ''
    lines.push(`  ${finding.severity} ${finding.ruleId}${pointer}: ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}
