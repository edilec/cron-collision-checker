#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises'
import process from 'node:process'
import { resolve } from 'node:path'

import {
  SCHEMA_VERSION,
  TOOL_ID,
  analyzeSchedules,
  exitCodeFor,
  formatReport,
  serializeReport,
} from '../src/index.mjs'

const MAX_CONFIG_BYTES = 1024 * 1024
const VERSION = '0.1.0'

const HELP = `cron-collision-checker

Expand five-field cron schedules over a bounded horizon in an explicit time
zone, then report overlapping runs, DST hazards and maintenance-window
violations.

Usage:
  cron-collision-checker --config FILE [--json] [--label NAME]

Options:
  --config FILE   Schedule configuration to check (JSON, max 1 MiB)
  --label NAME    Value recorded as location.file in the report
                  (defaults to the --config value as written)
  --json          Suppress the human summary on stderr
  -h, --help      Show this help
  -v, --version   Show the version

Output:
  stdout  the JSON report only, so it can be piped straight into a parser
  stderr  a human summary and progress diagnostics

Exit codes:
  0  every schedule was expanded and no policy finding was raised
  1  schedules were expanded and at least one policy finding failed
  2  invalid configuration, unreadable input, or a bound was exceeded
     (the report status is "incomplete" and never "pass")
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  if (argv.includes('-v') || argv.includes('--version')) return { version: true }
  const options = { config: null, label: null, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--label') options.label = takeValue('--label')
    else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.config === null) throw new Error('--config is required')
  return options
}

/** A report that carries the reason the input could not be evaluated. */
function incompleteReport(label, ruleId, message, suggestion) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    status: 'incomplete',
    summary: {
      checked: 0,
      errors: 1,
      warnings: 0,
      jobs: 0,
      occurrences: 0,
      collisions: 0,
      maintenanceWindows: 0,
      dstSkipped: 0,
      dstAmbiguous: 0,
    },
    findings: [
      {
        ruleId,
        severity: 'error',
        message,
        location: { file: label },
        suggestion,
      },
    ],
  }
}

async function loadConfig(path, label) {
  let stats
  try {
    stats = await stat(resolve(path))
  } catch (error) {
    return incompleteReport(
      label,
      'input-unreadable',
      `configuration could not be read: ${error.code ?? 'unknown error'}`,
      'Check the --config path and its permissions.',
    )
  }
  if (!stats.isFile()) {
    return incompleteReport(label, 'input-unreadable', 'configuration path is not a regular file', 'Pass a JSON file to --config.')
  }
  if (stats.size > MAX_CONFIG_BYTES) {
    return incompleteReport(
      label,
      'input-too-large',
      `configuration is ${stats.size} bytes; the limit is ${MAX_CONFIG_BYTES}`,
      'Split the configuration, or check a smaller set of jobs per run.',
    )
  }

  let text
  try {
    text = await readFile(resolve(path), 'utf8')
  } catch (error) {
    return incompleteReport(
      label,
      'input-unreadable',
      `configuration could not be read: ${error.code ?? 'unknown error'}`,
      'Check the --config path and its permissions.',
    )
  }

  try {
    return { config: JSON.parse(text) }
  } catch (error) {
    return incompleteReport(
      label,
      'input-unparsable',
      `configuration is not valid JSON: ${error.message}`,
      'Validate the file with a JSON parser before re-running.',
    )
  }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const label = options.label ?? options.config
  let report
  try {
    const loaded = await loadConfig(options.config, label)
    report =
      loaded.config === undefined
        ? loaded
        : analyzeSchedules(loaded.config, {
            configLabel: label,
            onDiagnostic: (line) => process.stderr.write(`${line}\n`),
          })
  } catch (error) {
    report = incompleteReport(
      label,
      'execution-failure',
      `the check could not be completed: ${error instanceof Error ? error.message : String(error)}`,
      'Re-run with a smaller configuration and report the failure if it persists.',
    )
  }

  process.stdout.write(`${serializeReport(report)}\n`)
  if (!options.json) process.stderr.write(formatReport(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
