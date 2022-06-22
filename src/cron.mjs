/**
 * Bounded five-field cron parser.
 *
 * Deliberately strict: everything it accepts is expanded into explicit value
 * sets, and everything it rejects is rejected with a stable rule id instead of
 * being guessed at. No dependency, no network, no clock.
 */

export class CronSyntaxError extends Error {
  constructor(ruleId, message) {
    super(message)
    this.name = 'CronSyntaxError'
    this.ruleId = ruleId
  }
}

export const MAX_CRON_LENGTH = 200

const MONTH_NAMES = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
])

const DAY_NAMES = new Map([
  ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3],
  ['thu', 4], ['fri', 5], ['sat', 6],
])

const FIELDS = [
  { key: 'minutes', label: 'minute', min: 0, max: 59, names: null },
  { key: 'hours', label: 'hour', min: 0, max: 23, names: null },
  { key: 'daysOfMonth', label: 'day-of-month', min: 1, max: 31, names: null },
  { key: 'months', label: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { key: 'daysOfWeek', label: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
]

const MACROS = new Map([
  ['@yearly', '0 0 1 1 *'],
  ['@annually', '0 0 1 1 *'],
  ['@monthly', '0 0 1 * *'],
  ['@weekly', '0 0 * * 0'],
  ['@daily', '0 0 * * *'],
  ['@midnight', '0 0 * * *'],
  ['@hourly', '0 * * * *'],
])

const PART_GRAMMAR = /^(?:(\*)|(\d{1,2}|[A-Za-z]{3})(?:-(\d{1,2}|[A-Za-z]{3}))?)(?:\/(\d{1,4}))?$/
// Quartz / Vixie extensions this parser does not implement. The lookarounds keep
// month and day names such as "jul" and "wed" from tripping the L/W markers.
const EXTENDED_SYNTAX = /[#?]|(?:^|[^A-Za-z])[LlWw](?![A-Za-z])/

function atomValue(raw, field) {
  if (field.names) {
    const named = field.names.get(raw.toLowerCase())
    if (named !== undefined) return named
  }
  if (!/^\d{1,2}$/.test(raw)) {
    throw new CronSyntaxError(
      'cron-syntax',
      `${field.label} value "${raw}" is neither a number nor a name this parser knows`,
    )
  }
  const value = Number(raw)
  if (value < field.min || value > field.max) {
    throw new CronSyntaxError(
      'cron-syntax',
      `${field.label} value "${raw}" is outside the allowed range ${field.min}-${field.max}`,
    )
  }
  return value
}

function inclusiveRange(from, to, field) {
  const values = []
  if (from <= to) {
    for (let value = from; value <= to; value += 1) values.push(value)
    return values
  }
  // Vixie cron wraps a descending range, e.g. hours 22-2 means 22,23,0,1,2.
  for (let value = from; value <= field.max; value += 1) values.push(value)
  for (let value = field.min; value <= to; value += 1) values.push(value)
  return values
}

function parseField(text, field) {
  if (text.length === 0) {
    throw new CronSyntaxError('cron-syntax', `${field.label} field is empty`)
  }
  const collected = new Set()
  for (const part of text.split(',')) {
    if (part.length === 0) {
      throw new CronSyntaxError('cron-syntax', `${field.label} field has an empty list entry`)
    }
    const match = PART_GRAMMAR.exec(part)
    if (!match) {
      if (EXTENDED_SYNTAX.test(part)) {
        throw new CronSyntaxError(
          'cron-unsupported-syntax',
          `${field.label} entry "${part}" uses an extended cron feature (L, W, # or ?) that this parser does not implement`,
        )
      }
      throw new CronSyntaxError('cron-syntax', `${field.label} entry "${part}" is not valid cron syntax`)
    }
    const [, star, first, last, rawStep] = match
    let values
    if (star) {
      values = inclusiveRange(field.min, field.max, field)
    } else if (last !== undefined) {
      values = inclusiveRange(atomValue(first, field), atomValue(last, field), field)
    } else if (rawStep !== undefined) {
      throw new CronSyntaxError(
        'cron-unsupported-syntax',
        `${field.label} entry "${part}" applies a step to a single value; write a range such as "${first}-${field.max}/${rawStep}" instead`,
      )
    } else {
      values = [atomValue(first, field)]
    }

    if (rawStep !== undefined) {
      const step = Number(rawStep)
      const span = field.max - field.min + 1
      if (!Number.isInteger(step) || step < 1 || step > span) {
        throw new CronSyntaxError(
          'cron-syntax',
          `${field.label} entry "${part}" has step ${rawStep}; a step must be an integer between 1 and ${span}`,
        )
      }
      values = values.filter((_value, index) => index % step === 0)
    }
    for (const value of values) collected.add(value)
  }
  return collected
}

/**
 * Parse a five-field cron expression (or a supported @macro) into explicit
 * value sets. Throws CronSyntaxError with a stable `ruleId` on rejection.
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw new CronSyntaxError('cron-syntax', 'cron expression must be a string')
  }
  if (expression.length > MAX_CRON_LENGTH) {
    throw new CronSyntaxError(
      'cron-too-long',
      `cron expression is ${expression.length} characters; the limit is ${MAX_CRON_LENGTH}`,
    )
  }
  const trimmed = expression.trim()
  if (trimmed.length === 0) {
    throw new CronSyntaxError('cron-syntax', 'cron expression is empty')
  }

  let source = trimmed
  if (source.startsWith('@')) {
    const macro = MACROS.get(source.toLowerCase())
    if (macro === undefined) {
      throw new CronSyntaxError(
        'cron-unsupported-macro',
        `cron macro "${source}" has no fixed wall-clock expansion this tool can expand`,
      )
    }
    source = macro
  }

  const fields = source.split(/\s+/)
  if (fields.length !== 5) {
    throw new CronSyntaxError(
      'cron-field-count',
      `cron expression has ${fields.length} fields; this tool reads exactly 5 (minute hour day-of-month month day-of-week)`,
    )
  }

  const parsed = {}
  for (let index = 0; index < FIELDS.length; index += 1) {
    parsed[FIELDS[index].key] = parseField(fields[index], FIELDS[index])
  }

  const daysOfWeek = new Set()
  for (const value of parsed.daysOfWeek) daysOfWeek.add(value === 7 ? 0 : value)

  const ascending = (a, b) => a - b
  return {
    expression: trimmed,
    normalized: source,
    minutes: [...parsed.minutes].sort(ascending),
    hours: [...parsed.hours].sort(ascending),
    daysOfMonth: parsed.daysOfMonth,
    months: parsed.months,
    daysOfWeek,
    dayOfMonthRestricted: fields[2] !== '*',
    dayOfWeekRestricted: fields[4] !== '*',
  }
}

/**
 * Vixie day matching: when both day-of-month and day-of-week are restricted the
 * job runs when EITHER matches; otherwise the restricted field alone decides.
 */
export function matchesDate(spec, month, dayOfMonth, dayOfWeek) {
  if (!spec.months.has(month)) return false
  const domHit = spec.daysOfMonth.has(dayOfMonth)
  const dowHit = spec.daysOfWeek.has(dayOfWeek)
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) return domHit || dowHit
  if (spec.dayOfMonthRestricted) return domHit
  if (spec.dayOfWeekRestricted) return dowHit
  return true
}
