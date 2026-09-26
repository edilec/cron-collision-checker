import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = join(root, 'bin', 'cron-collision-checker.mjs')

/** Invoke the published CLI exactly as a consumer would. */
async function cron(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { cwd: root })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('--help prints usage on stdout and exits 0', async () => {
  const result = await cron(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /Usage:\n {2}cron-collision-checker --config FILE/)
  assert.match(result.stdout, /Exit codes:/)
  assert.equal(result.stderr, '')
})

test('--version prints the package version', async () => {
  const result = await cron(['--version'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '0.1.0\n')
})

test('acceptance: the clean example passes and stdout is JSON and nothing else', async () => {
  const result = await cron(['--config', 'examples/clean.json'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'cron-collision-checker')
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.occurrences, 13)
  assert.equal(report.location, undefined)
  // Diagnostics and the human summary go to stderr, never to stdout.
  assert.match(result.stderr, /expanded job nightly-backup/)
  assert.match(result.stderr, /cron-collision-checker: pass/)
})

test('--json keeps the human summary off stderr but still reports diagnostics', async () => {
  const result = await cron(['--config', 'examples/clean.json', '--json'])
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).status, 'pass')
  assert.match(result.stderr, /expanded job nightly-backup/)
  assert.doesNotMatch(result.stderr, /cron-collision-checker: pass/)
})

test('acceptance: the spring-forward example fails with a skipped run and exits 1', async () => {
  const result = await cron(['--config', 'examples/spring-forward.json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  const skipped = report.findings.filter((finding) => finding.ruleId === 'dst-skipped')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].evidence, 'skipped: 2026-03-08 02:00')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'resource-contention'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'maintenance-window-collision'))
  for (const finding of report.findings) {
    assert.equal(finding.location.file, 'examples/spring-forward.json')
  }
})

test('acceptance: the fall-back example reports both instants of an ambiguous time', async () => {
  const result = await cron(['--config', 'examples/fall-back.json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  const ambiguous = report.findings.filter((finding) => finding.ruleId === 'dst-ambiguous')
  assert.equal(ambiguous.length, 2)
  assert.match(ambiguous[0].evidence, /2026-11-01T05:30:00Z \(-04:00\).*2026-11-01T06:30:00Z \(-05:00\)/)
  assert.equal(report.summary.dstAmbiguous, 2)
})

test('acceptance: an unbounded schedule exits 2 as incomplete instead of running away', async () => {
  const started = process.hrtime.bigint()
  const result = await cron(['--config', 'examples/unbounded.json'])
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.occurrences, 100)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'limit-occurrences-exceeded'))
  assert.ok(elapsedMs < 30000, `bounded CLI run took ${elapsedMs.toFixed(0)}ms`)
})

test('a missing config is incomplete on stdout and exits 2', async () => {
  const result = await cron(['--config', 'examples/does-not-exist.json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'input-unreadable')
  assert.equal(report.findings[0].location.file, 'examples/does-not-exist.json')
})

test('unparsable JSON is incomplete on stdout and exits 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cron-collision-checker-'))
  try {
    const broken = join(directory, 'broken.json')
    await writeFile(broken, '{ "timezone": "UTC", ', 'utf8')
    const result = await cron(['--config', broken, '--label', 'broken.json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'input-unparsable')
    // --label keeps the host path out of the report.
    assert.equal(report.findings[0].location.file, 'broken.json')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a config that is a directory rather than a file is rejected', async () => {
  const result = await cron(['--config', 'examples'])
  assert.equal(result.code, 2)
  assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'input-unreadable')
})

test('usage errors print help on stderr and leave stdout empty', async () => {
  for (const args of [[], ['--config'], ['--nope', 'x'], ['--config', 'examples/clean.json', '--label']]) {
    const result = await cron(args)
    assert.equal(result.code, 2, `args: ${args.join(' ')}`)
    assert.equal(result.stdout, '', `args: ${args.join(' ')}`)
    assert.match(result.stderr, /Usage:/)
  }
})

test('acceptance: the same input twice produces byte-identical stdout', async () => {
  for (const example of ['clean', 'spring-forward', 'fall-back', 'unbounded']) {
    const first = await cron(['--config', `examples/${example}.json`, '--json'])
    const second = await cron(['--config', `examples/${example}.json`, '--json'])
    assert.equal(first.stdout, second.stdout, `${example} is not deterministic`)
    assert.equal(first.code, second.code)
    assert.ok(first.stdout.endsWith('}\n'))
  }
})

test('a config that exceeds the input byte bound is rejected before parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cron-collision-checker-'))
  try {
    const huge = join(directory, 'huge.json')
    await writeFile(huge, `{"padding":"${'p'.repeat(1024 * 1024 + 16)}"}`, 'utf8')
    const result = await cron(['--config', huge, '--label', 'huge.json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'input-too-large')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * A configuration file is exactly the kind of document that carries a token in
 * an environment block or a credential in a job command, and this tool writes
 * its report to stdout -- a stream that is piped into a CI log. Nothing from
 * inside the file may be echoed.
 *
 * The parse-failure path is where that used to break. V8 reports a JSON parse
 * failure two ways, and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A file
 * short enough to be nothing but a credential was reproduced in full by its
 * own error message. Clamping could not repair it -- `clampEvidence` cuts from
 * the end and the quoted snippet is at the front.
 *
 * The canaries are published placeholders, never real credentials: the example
 * key from the AWS documentation, the standard test card number that
 * authorises nothing, and a host under the RFC 2606 `.invalid` reserved
 * top-level domain. Every prefix from eight characters up is scanned on both
 * streams: a check of the whole value alone passes for a report that leaks all
 * but the last character.
 */
const CANARIES = Object.freeze({
  'AWS example access key id': 'AKIAIOSFODNN7EXAMPLE',
  'standard test card number': 'x4111111111111111',
  'reserved example host': 'api.example.invalid',
  'bearer-looking token': 'Bearer-ZXhhbXBsZS10b2tlbg',
})

const MIN_PREFIX = 8

test('an unparsable config is not quoted back by its own parse error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cron-collision-checker-'))
  try {
    for (const [name, canary] of Object.entries(CANARIES)) {
      const planted = join(directory, 'planted.json')
      await writeFile(planted, canary, 'utf8')
      const result = await cron(['--config', planted, '--label', 'planted.json'])
      const report = JSON.parse(result.stdout)
      assert.equal(report.findings[0].ruleId, 'input-unparsable', 'the file must really have failed to parse')

      for (let length = MIN_PREFIX; length <= canary.length; length += 1) {
        const prefix = canary.slice(0, length)
        assert.equal(result.stdout.includes(prefix), false, `${name}: "${prefix}" reached stdout`)
        assert.equal(result.stderr.includes(prefix), false, `${name}: "${prefix}" reached stderr`)
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * The other half of the fix: a diagnostic that says nothing is a different
 * defect. A configuration truncated partway through reports a position rather
 * than a quotation, and that position is what a reader needs to find the spot.
 */
test('a parse failure still says where the config went wrong', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cron-collision-checker-'))
  try {
    const broken = join(directory, 'broken.json')
    await writeFile(broken, '{ "timezone": "UTC", ', 'utf8')
    const result = await cron(['--config', broken, '--label', 'broken.json'])
    const { message } = JSON.parse(result.stdout).findings[0]
    assert.match(message, /position \d+/)
    assert.match(message, /line \d+ column \d+/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
