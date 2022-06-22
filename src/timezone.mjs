/**
 * Wall-clock <-> instant conversion built on Intl.DateTimeFormat.
 *
 * Node ships the IANA time zone database with its ICU data, so an explicit
 * `timeZone` option is all that is needed - no tzdata dependency, no network.
 *
 * "Local milliseconds" below means a wall-clock date-time encoded as if it were
 * UTC. It is a label for a calendar reading, not an instant: during a
 * spring-forward gap no instant carries that label, and during a fall-back
 * overlap two instants do.
 */

const MS_PER_MINUTE = 60000
const MS_PER_DAY = 86400000
const EPOCH_SHIFT = 719468
const MAX_CACHED_FORMATTERS = 64

const formatters = new Map()

function formatterFor(timeZone) {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  // `en-US` + latn + h23 are pinned so that part values are ASCII digits in a
  // known calendar on every host; only the tz database itself is consulted.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  if (formatters.size >= MAX_CACHED_FORMATTERS) formatters.clear()
  formatters.set(timeZone, formatter)
  return formatter
}

export function isKnownTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant). */
export function daysFromCivil(year, month, day) {
  const shiftedYear = month <= 2 ? year - 1 : year
  const era = Math.floor(shiftedYear / 400)
  const yearOfEra = shiftedYear - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - EPOCH_SHIFT
}

/** Inverse of daysFromCivil. */
export function civilFromDays(days) {
  const shifted = days + EPOCH_SHIFT
  const era = Math.floor(shifted / 146097)
  const dayOfEra = shifted - era * 146097
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  )
  const year = yearOfEra + era * 400
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1
  const month = monthPrime + (monthPrime < 10 ? 3 : -9)
  return { year: month <= 2 ? year + 1 : year, month, day }
}

/** 0 = Sunday. 1970-01-01 was a Thursday. */
export function dayOfWeekFromDays(days) {
  return ((days % 7) + 11) % 7
}

export function localMsFromFields(year, month, day, hour, minute, second = 0) {
  return ((daysFromCivil(year, month, day) * 24 + hour) * 60 + minute) * 60000 + second * 1000
}

export function fieldsFromLocalMs(localMs) {
  const days = Math.floor(localMs / MS_PER_DAY)
  const rest = localMs - days * MS_PER_DAY
  const civil = civilFromDays(days)
  return {
    year: civil.year,
    month: civil.month,
    day: civil.day,
    hour: Math.floor(rest / 3600000),
    minute: Math.floor(rest / 60000) % 60,
    second: Math.floor(rest / 1000) % 60,
  }
}

/** Wall-clock calendar fields observed in `timeZone` at an instant. */
export function fieldsAt(timeZone, instantMs) {
  const parts = formatterFor(timeZone).formatToParts(instantMs)
  const read = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of parts) {
    if (part.type in read) read[part.type] = Number(part.value)
  }
  return read
}

function localMsAt(timeZone, instantMs) {
  const f = fieldsAt(timeZone, instantMs)
  return localMsFromFields(f.year, f.month, f.day, f.hour, f.minute, f.second)
}

/**
 * UTC offset in milliseconds that `timeZone` was observing at an instant.
 *
 * The instant is floored to its second first: Intl reports whole seconds, so
 * probing a sub-second instant directly would fold the leftover milliseconds
 * into the offset and make an ordinary run look like it crossed a transition.
 */
export function offsetMsAt(timeZone, instantMs) {
  const wholeSecond = Math.floor(instantMs / 1000) * 1000
  return localMsAt(timeZone, wholeSecond) - wholeSecond
}

/**
 * Every instant whose wall clock in `timeZone` reads `localMs`.
 *
 * Returns 0 instants for a spring-forward gap, 1 for an ordinary time and 2 for
 * a fall-back overlap, always sorted ascending. This is the offset-probe
 * algorithm Temporal specifies for getPossibleInstantsFor: a transition never
 * moves a clock by a whole day, so probing the offsets one day either side of
 * the naive reading yields every candidate, and each candidate is then verified
 * by converting back.
 */
export function instantsForLocalMs(timeZone, localMs) {
  const before = offsetMsAt(timeZone, localMs - MS_PER_DAY)
  const after = offsetMsAt(timeZone, localMs + MS_PER_DAY)
  const offsets = before === after ? [before] : [before, after]
  const found = []
  for (const offset of offsets) {
    const candidate = localMs - offset
    if (found.includes(candidate)) continue
    if (localMsAt(timeZone, candidate) === localMs) found.push(candidate)
  }
  return found.sort((a, b) => a - b)
}

/**
 * The instant a skipped wall-clock reading would nominally have fallen on, used
 * only to decide whether a gap lands inside the horizon.
 */
export function nominalInstantForLocalMs(timeZone, localMs) {
  return localMs - offsetMsAt(timeZone, localMs)
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

export function formatInstant(instantMs) {
  return new Date(instantMs).toISOString().replace('.000Z', 'Z')
}

export function formatWallClock(localMs) {
  const f = fieldsFromLocalMs(localMs)
  return `${pad(f.year, 4)}-${pad(f.month, 2)}-${pad(f.day, 2)} ${pad(f.hour, 2)}:${pad(f.minute, 2)}`
}

export function formatOffset(offsetMs) {
  const sign = offsetMs < 0 ? '-' : '+'
  const totalMinutes = Math.round(Math.abs(offsetMs) / MS_PER_MINUTE)
  return `${sign}${pad(Math.floor(totalMinutes / 60), 2)}:${pad(totalMinutes % 60, 2)}`
}

/** "2026-11-01 01:30 -04:00" - the reading a operator would see on the host. */
export function describeLocal(timeZone, instantMs) {
  const offset = offsetMsAt(timeZone, instantMs)
  return `${formatWallClock(instantMs + offset)} ${formatOffset(offset)}`
}
