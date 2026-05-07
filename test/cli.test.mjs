import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.mjs';

// Build a fake argv array: ['node', 'index.mjs', ...flags]
const argv = (...flags) => ['node', 'index.mjs', ...flags];

describe('parseArgs', () => {

  // Preserve and restore env vars modified by tests
  let origFolderId;
  before(() => { origFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID; });
  after(() => {
    if (origFolderId === undefined) delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    else process.env.GOOGLE_DRIVE_FOLDER_ID = origFolderId;
  });

  // ── Defaults ──────────────────────────────────────────────────────────────

  it('returns safe defaults when no flags are given', () => {
    delete process.env.GOOGLE_DRIVE_FOLDER_ID;
    const opts = parseArgs(argv());
    assert.equal(opts.driveFolderId, null);
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
