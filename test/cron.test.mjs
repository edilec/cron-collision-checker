import assert from 'node:assert/strict'
import test from 'node:test'

import { CronSyntaxError, matchesDate, parseCron } from '../src/cron.mjs'
import { civilFromDays, dayOfWeekFromDays, daysFromCivil } from '../src/timezone.mjs'

function rejectionRuleId(expression) {
  try {
    parseCron(expression)
  } catch (error) {
    assert.ok(error instanceof CronSyntaxError, `expected CronSyntaxError for ${expression}`)
    return error.ruleId
  }
  throw new assert.AssertionError({ message: `expected "${expression}" to be rejected` })
}

test('parses a plain five-field expression into explicit value sets', () => {
  const spec = parseCron('30 2 * * *')
  assert.deepEqual(spec.minutes, [30])
  assert.deepEqual(spec.hours, [2])
  assert.equal(spec.daysOfMonth.size, 31)
  assert.equal(spec.months.size, 12)
  assert.equal(spec.daysOfWeek.size, 7)
  assert.equal(spec.dayOfMonthRestricted, false)
  assert.equal(spec.dayOfWeekRestricted, false)
})

test('expands steps, ranges and lists', () => {
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45])
  assert.deepEqual(parseCron('0 8-11/2 * * *').hours, [8, 10])
  assert.deepEqual(parseCron('0,5,59 * * * *').minutes, [0, 5, 59])
})

test('accepts month and weekday names without mistaking them for L or W extensions', () => {
  assert.deepEqual([...parseCron('0 0 * JUL *').months], [7])
  assert.deepEqual([...parseCron('0 0 * * WED').daysOfWeek], [3])
  assert.deepEqual([...parseCron('0 0 * * MON-FRI').daysOfWeek].sort(), [1, 2, 3, 4, 5])
})

test('normalises weekday 7 to Sunday', () => {
  assert.deepEqual([...parseCron('0 0 * * 7').daysOfWeek], [0])
  assert.deepEqual([...parseCron('0 0 * * 0').daysOfWeek], [0])
})

test('wraps a descending range the way Vixie cron does', () => {
  assert.deepEqual(parseCron('0 22-2 * * *').hours, [0, 1, 2, 22, 23])
  assert.deepEqual([...parseCron('0 0 * * FRI-MON').daysOfWeek].sort(), [0, 1, 5, 6])
})

test('expands the supported @macros', () => {
  assert.equal(parseCron('@daily').normalized, '0 0 * * *')
  assert.equal(parseCron('@hourly').normalized, '0 * * * *')
  assert.deepEqual([...parseCron('@weekly').daysOfWeek], [0])
})

test('rejects unsupported and malformed expressions with stable rule ids', () => {
  assert.equal(rejectionRuleId('@reboot'), 'cron-unsupported-macro')
  assert.equal(rejectionRuleId('@sometimes'), 'cron-unsupported-macro')
  assert.equal(rejectionRuleId('0 0 L * *'), 'cron-unsupported-syntax')
  assert.equal(rejectionRuleId('0 0 15W * *'), 'cron-unsupported-syntax')
  assert.equal(rejectionRuleId('0 0 * * MON#2'), 'cron-unsupported-syntax')
  assert.equal(rejectionRuleId('0 0 ? * *'), 'cron-unsupported-syntax')
  assert.equal(rejectionRuleId('5/10 * * * *'), 'cron-unsupported-syntax')
  assert.equal(rejectionRuleId('0 0 * *'), 'cron-field-count')
  assert.equal(rejectionRuleId('0 0 * * * *'), 'cron-field-count')
  assert.equal(rejectionRuleId('60 * * * *'), 'cron-syntax')
  assert.equal(rejectionRuleId('0 24 * * *'), 'cron-syntax')
  assert.equal(rejectionRuleId('0 0 * * XYZ'), 'cron-syntax')
  assert.equal(rejectionRuleId('*/0 * * * *'), 'cron-syntax')
  assert.equal(rejectionRuleId('0,, * * * *'), 'cron-syntax')
  assert.equal(rejectionRuleId(''), 'cron-syntax')
  assert.equal(rejectionRuleId(`${'0'.repeat(201)} * * * *`), 'cron-too-long')
  assert.equal(rejectionRuleId(42), 'cron-syntax')
})

test('day matching uses OR only when both day fields are restricted', () => {
  const both = parseCron('0 0 13 * FRI')
  // 2026-02-13 is a Friday: matched by either field.
  assert.equal(matchesDate(both, 2, 13, 5), true)
  // The 13th of a month that is not a Friday still matches via day-of-month.
  assert.equal(matchesDate(both, 3, 13, 5), true)
  assert.equal(matchesDate(both, 1, 2, 5), true, 'any Friday matches')
  assert.equal(matchesDate(both, 1, 13, 2), true, 'any 13th matches')
  assert.equal(matchesDate(both, 1, 14, 3), false)

  const domOnly = parseCron('0 0 13 * *')
  assert.equal(domOnly.dayOfWeekRestricted, false)
  assert.equal(matchesDate(domOnly, 1, 2, 5), false, 'a Friday that is not the 13th does not match')
  assert.equal(matchesDate(domOnly, 1, 13, 2), true)

  const monthBound = parseCron('0 0 1 JAN *')
  assert.equal(matchesDate(monthBound, 2, 1, 0), false)
  assert.equal(matchesDate(monthBound, 1, 1, 0), true)
})

test('civil date arithmetic round-trips and knows the weekday', () => {
  assert.equal(daysFromCivil(1970, 1, 1), 0)
  assert.equal(dayOfWeekFromDays(0), 4, '1970-01-01 was a Thursday')
  assert.equal(dayOfWeekFromDays(daysFromCivil(2026, 6, 7)), 0, '2026-06-07 is a Sunday')
  assert.equal(dayOfWeekFromDays(daysFromCivil(2026, 3, 8)), 0, '2026-03-08 is a Sunday')
  assert.deepEqual(civilFromDays(daysFromCivil(2024, 2, 29)), { year: 2024, month: 2, day: 29 })
  assert.deepEqual(civilFromDays(daysFromCivil(1969, 12, 31)), { year: 1969, month: 12, day: 31 })
  for (let days = -400; days <= 40000; days += 173) {
    const civil = civilFromDays(days)
    assert.equal(daysFromCivil(civil.year, civil.month, civil.day), days)
  }
})
