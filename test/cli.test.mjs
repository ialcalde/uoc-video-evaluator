import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, USAGE } from '../src/cli.mjs';

// Build a fake argv array: ['node', 'index.mjs', ...flags]
const argv = (...flags) => ['node', 'index.mjs', ...flags];

describe('parseArgs', () => {

  // Preserve and restore env vars modified by tests
  let origFolderId, origModel;
  before(() => {
    origFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    origModel    = process.env.ANTHROPIC_MODEL;
  });
  after(() => {
    if (origFolderId === undefined) delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_FOLDER_ID = origFolderId;
    if (origModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = origModel;
  });

  // ── Defaults ──────────────────────────────────────────────────────────────

  it('returns safe defaults when no flags are given', () => {
    delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    delete process.env.ANTHROPIC_MODEL;
    const opts = parseArgs(argv());
    assert.equal(opts.driveFolderId, null);
    assert.equal(opts.model,         'claude-sonnet-4-6');
    assert.equal(opts.skipExisting,  false);
    assert.equal(opts.concurrency,   3);
    assert.equal(opts.outputDir,     null);
    assert.equal(opts.dryRun,        false);
  });

  // ── --drive-folder ────────────────────────────────────────────────────────

  it('parses --drive-folder', () => {
    delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    const opts = parseArgs(argv('--drive-folder', 'abc123'));
    assert.equal(opts.driveFolderId, 'abc123');
  });

  it('falls back to GOOGLE_DRIVE_FOLDER_ID env var', () => {
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'env-folder-id';
    const opts = parseArgs(argv());
    assert.equal(opts.driveFolderId, 'env-folder-id');
  });

  it('CLI --drive-folder takes precedence over env var', () => {
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'env-folder-id';
    const opts = parseArgs(argv('--drive-folder', 'cli-folder-id'));
    assert.equal(opts.driveFolderId, 'cli-folder-id');
  });

  // ── --skip-existing ───────────────────────────────────────────────────────

  it('parses --skip-existing', () => {
    const opts = parseArgs(argv('--skip-existing'));
    assert.equal(opts.skipExisting, true);
  });

  // ── --concurrency ─────────────────────────────────────────────────────────

  it('parses --concurrency as an integer', () => {
    const opts = parseArgs(argv('--concurrency', '5'));
    assert.equal(opts.concurrency, 5);
  });

  it('clamps --concurrency to a minimum of 1', () => {
    assert.equal(parseArgs(argv('--concurrency', '0')).concurrency, 1);
    assert.equal(parseArgs(argv('--concurrency', '-3')).concurrency, 1);
  });

  it('defaults --concurrency to 1 when value is not a number', () => {
    assert.equal(parseArgs(argv('--concurrency', 'abc')).concurrency, 1);
  });

  // ── --output-dir ──────────────────────────────────────────────────────────

  it('parses --output-dir', () => {
    const opts = parseArgs(argv('--output-dir', '/tmp/results'));
    assert.equal(opts.outputDir, '/tmp/results');
  });

  it('defaults outputDir to null when flag is absent', () => {
    assert.equal(parseArgs(argv()).outputDir, null);
  });

  // ── --dry-run ─────────────────────────────────────────────────────────────

  it('parses --dry-run', () => {
    const opts = parseArgs(argv('--dry-run'));
    assert.equal(opts.dryRun, true);
  });

  // ── --model ───────────────────────────────────────────────────────────────

  it('parses --model', () => {
    delete process.env.ANTHROPIC_MODEL;
    const opts = parseArgs(argv('--model', 'claude-opus-4-7'));
    assert.equal(opts.model, 'claude-opus-4-7');
  });

  it('falls back to ANTHROPIC_MODEL env var when --model is absent', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
    const opts = parseArgs(argv());
    assert.equal(opts.model, 'claude-haiku-4-5');
  });

  it('CLI --model takes precedence over ANTHROPIC_MODEL env var', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
    const opts = parseArgs(argv('--model', 'claude-opus-4-7'));
    assert.equal(opts.model, 'claude-opus-4-7');
  });

  // ── --version ─────────────────────────────────────────────────────────────

  it('parses --version', () => {
    assert.equal(parseArgs(argv('--version')).version, true);
  });

  it('defaults version to false when flag is absent', () => {
    assert.equal(parseArgs(argv()).version, false);
  });

  // ── --rebuild-csv ─────────────────────────────────────────────────────────

  it('parses --rebuild-csv', () => {
    assert.equal(parseArgs(argv('--rebuild-csv')).rebuildCsv, true);
  });

  it('defaults rebuildCsv to false when flag is absent', () => {
    assert.equal(parseArgs(argv()).rebuildCsv, false);
  });

  // ── --thinking ────────────────────────────────────────────────────────────

  it('parses --thinking', () => {
    assert.equal(parseArgs(argv('--thinking')).thinking, true);
  });

  it('defaults thinking to false when flag is absent', () => {
    assert.equal(parseArgs(argv()).thinking, false);
  });

  // ── --help ────────────────────────────────────────────────────────────────

  it('sets help=true for --help', () => {
    assert.equal(parseArgs(argv('--help')).help, true);
  });

  it('sets help=true for -h', () => {
    assert.equal(parseArgs(argv('-h')).help, true);
  });

  it('defaults help to false when flag is absent', () => {
    assert.equal(parseArgs(argv()).help, false);
  });

  it('USAGE string includes all supported flags', () => {
    for (const flag of [
      '--drive-folder', '--model', '--skip-existing', '--concurrency',
      '--output-dir', '--dry-run', '--rebuild-csv', '--thinking',
      '--version', '--help',
    ]) {
      assert.ok(USAGE.includes(flag), `USAGE should mention ${flag}`);
    }
  });

  // ── Combined flags ────────────────────────────────────────────────────────

  // ── Unknown flags ─────────────────────────────────────────────────────────

  it('uses console.warn default onUnknown when no handler is provided', () => {
    // Call with an unknown flag and no custom onUnknown — exercises the default
    // onUnknown = flag => console.warn(...) arrow function.
    const orig = console.warn;
    const warned = [];
    console.warn = msg => warned.push(msg);
    try {
      parseArgs(argv('--unknown-flag-xyz'));
    } finally {
      console.warn = orig;
    }
    assert.ok(warned.some(m => m.includes('--unknown-flag-xyz')), 'default onUnknown should call console.warn');
  });

  it('calls onUnknown for unrecognised flags starting with -', () => {
    const unknown = [];
    parseArgs(argv('--typo-flag'), flag => unknown.push(flag));
    assert.deepEqual(unknown, ['--typo-flag']);
  });

  it('does not call onUnknown for recognised flags', () => {
    const unknown = [];
    parseArgs(argv('--skip-existing', '--dry-run'), flag => unknown.push(flag));
    assert.deepEqual(unknown, []);
  });

  it('does not emit a warning for bare arguments (non-flag tokens)', () => {
    const unknown = [];
    parseArgs(argv('somevalue'), flag => unknown.push(flag));
    assert.deepEqual(unknown, [], 'non-flag tokens are not treated as unknown flags');
  });

  it('warns once per unknown flag when multiple unrecognised flags are passed', () => {
    const unknown = [];
    parseArgs(argv('--bad-one', '--bad-two'), flag => unknown.push(flag));
    assert.equal(unknown.length, 2);
    assert.ok(unknown.includes('--bad-one'));
    assert.ok(unknown.includes('--bad-two'));
  });

  // ── Combined flags ────────────────────────────────────────────────────────

  it('parses multiple flags together', () => {
    delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    const opts = parseArgs(argv(
      '--drive-folder', 'f1',
      '--skip-existing',
      '--concurrency', '4',
      '--output-dir', '/out',
      '--dry-run',
    ));
    assert.equal(opts.driveFolderId, 'f1');
    assert.equal(opts.skipExisting,  true);
    assert.equal(opts.concurrency,   4);
    assert.equal(opts.outputDir,     '/out');
    assert.equal(opts.dryRun,        true);
  });

});
