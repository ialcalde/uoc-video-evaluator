/**
 * UOC Video Evaluator — Batch Orchestrator
 *
 * Sources (mutually exclusive, Drive takes precedence):
 *   --drive-folder <id>   or  GOOGLE_DRIVE_FOLDER_ID=<id>  → download from Drive
 *   (default)                                               → read from input_videos/
 *
 * Per-student output (output/<student>/):
 *   transcript_ca.txt   — Catalan transcript (Whisper)
 *   evaluation.json     — Claude's structured evaluation
 *   feedback_ca.txt     — Human-readable feedback in Catalan
 *
 * Consolidated output:
 *   output/results.csv
 *
 * Flags:
 *   --drive-folder <id>   Read videos from a Google Drive folder.
 *   --skip-existing       Skip students whose evaluation.json already exists.
 *   --concurrency <n>     Process up to N students in parallel (default: 3).
 *   --output-dir <path>   Write results to a custom directory (default: output/).
 *   --dry-run             List videos found without calling any API.
 *
 * Usage:
 *   node index.mjs
 *   node index.mjs --drive-folder 1AbCdEfGhIjKlMnOpQrStUvWxYz
 *   node index.mjs --skip-existing --concurrency 5
 *   node index.mjs --dry-run
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI    from 'openai';
import * as dotenv from 'dotenv';
import { existsSync, mkdirSync } from 'fs';
import { readFile, unlink }            from 'fs/promises';
import { basename, extname, join }     from 'path';
import { fileURLToPath }               from 'url';

import { validateRubric }    from './src/validate.mjs';
import { processVideo }      from './src/pipeline.mjs';
import { writeCsv }          from './src/report.mjs';
import { collectLocalVideos } from './src/source.mjs';
import { authorise, createDriveClient, listVideos, downloadVideo } from './src/drive.mjs';
import { runBatch } from './src/batch.mjs';
import { parseArgs } from './src/cli.mjs';

dotenv.config();

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname  = fileURLToPath(new URL('.', import.meta.url));
const INPUT_DIR  = join(__dirname, 'input_videos');
const OUTPUT_DIR = join(__dirname, 'output');
const TMP_DIR    = join(__dirname, 'tmp');

for (const dir of [INPUT_DIR, OUTPUT_DIR, TMP_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Logger ────────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 19); }
const log = {
  info:  msg => console.log( `[INFO]  ${ts()}  ${msg}`),
  ok:    msg => console.log( `[OK]    ${ts()}  ${msg}`),
  warn:  msg => console.warn(`[WARN]  ${ts()}  ${msg}`),
  error: msg => console.error(`[ERROR] ${ts()}  ${msg}`),
  sep:   ()  => console.log( `        ${'─'.repeat(52)}`),
};

// ── Video source: Google Drive ────────────────────────────────────────────────
async function collectDriveVideos(folderId) {
  const auth  = await authorise(log);
  const drive = createDriveClient(auth);

  log.info(`[Drive] Listing videos in folder: ${folderId}`);
  const files = await listVideos(folderId, drive);

  if (files.length === 0) {
    log.warn('[Drive] No video files found in the specified folder.');
    return [];
  }

  log.info(`[Drive] Found ${files.length} video(s). Downloading to tmp/…`);
  log.sep();

  const entries = [];

  for (const file of files) {
    const student = basename(file.name, extname(file.name));
    const destPath = join(TMP_DIR, file.name);
    const sizeMB   = file.size ? (Number(file.size) / 1_048_576).toFixed(1) : '?';

    log.info(`[Drive] Downloading "${file.name}" (${sizeMB} MB)…`);

    let lastLogged = 0;
    await downloadVideo(file.id, file.name, TMP_DIR, drive, bytes => {
      const mb = bytes / 1_048_576;
      if (mb - lastLogged >= 10) {        // log every 10 MB
        log.info(`[Drive]   … ${mb.toFixed(0)} MB received`);
        lastLogged = mb;
      }
    });

    log.ok(`[Drive] "${file.name}" ready.`);

    entries.push({
      videoPath: destPath,
      student,
      cleanup: async () => {
        try { await unlink(destPath); } catch { /* already gone */ }
      },
    });
  }

  log.sep();
  return entries;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { driveFolderId, skipExisting, concurrency, outputDir, dryRun } =
    parseArgs(process.argv);

  const OUT_DIR = outputDir ? outputDir : OUTPUT_DIR;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // ── Load and validate rubric (before env-var check — no API needed for this)
  const rubric = JSON.parse(
    await readFile(join(__dirname, 'rubric.json'), 'utf8')
  );
  try {
    validateRubric(rubric);
  } catch (err) {
    log.error(`Invalid rubric.json: ${err.message}`);
    process.exit(1);
  }

  // ── Collect videos ──────────────────────────────────────────────────────────
  let entries;

  if (driveFolderId) {
    log.info(`Source: Google Drive (folder: ${driveFolderId})`);
    entries = await collectDriveVideos(driveFolderId);
  } else {
    log.info('Source: local input_videos/');
    entries = collectLocalVideos(INPUT_DIR);
  }

  if (entries.length === 0) {
    if (!driveFolderId) {
      log.warn('No video files found in input_videos/.');
      log.warn('Add .mp4 / .mov / .mkv / .avi / .webm files, or use --drive-folder <id>.');
    }
    process.exit(0);
  }

  // ── Dry-run: list found videos and exit without calling any API ─────────────
  if (dryRun) {
    log.info(`[DRY RUN] Found ${entries.length} video(s):`);
    for (const { student, videoPath } of entries) {
      log.info(`  ${student.padEnd(30)} ${videoPath}`);
    }
    log.info('[DRY RUN] No API calls made. Remove --dry-run to process.');
    process.exit(0);
  }

  // ── Required env vars ───────────────────────────────────────────────────────
  const missingKeys = [];
  if (!process.env.ANTHROPIC_API_KEY) missingKeys.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missingKeys.push('OPENAI_API_KEY');
  if (driveFolderId) {
    if (!process.env.GOOGLE_CLIENT_ID)     missingKeys.push('GOOGLE_CLIENT_ID');
    if (!process.env.GOOGLE_CLIENT_SECRET) missingKeys.push('GOOGLE_CLIENT_SECRET');
  }
  if (missingKeys.length) {
    log.error(`Missing environment variables: ${missingKeys.join(', ')}`);
    log.error('Copy .env.example to .env and fill in your keys.');
    process.exit(1);
  }

  // ── Init API clients ────────────────────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  log.info(`Processing ${entries.length} video(s) — concurrency: ${concurrency}`);
  log.sep();

  // ── Process videos (bounded concurrency) ───────────────────────────────────
  const total = entries.length;
  const results = await runBatch(
    entries,
    async ({ videoPath, student, cleanup }, idx) => {
      log.info(`[${idx + 1}/${total}] Starting ${student}`);
      try {
        const evaluation = await processVideo({
          videoPath, student, anthropic, openai, rubric,
          skipExisting, outputDir: OUT_DIR, tmpDir: TMP_DIR, log,
        });
        return { student, status: 'ok', evaluation };
      } catch (err) {
        log.error(`[${student}] Failed: ${err.message}`);
        return { student, status: 'error', error: err.message };
      } finally {
        await cleanup?.();    // remove Drive-downloaded file after processing
        log.sep();
      }
    },
    concurrency
  );

  // ── Write CSV ───────────────────────────────────────────────────────────────
  const csvPath = await writeCsv(OUT_DIR, results, rubric);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const nOk    = results.filter(r => r.status === 'ok').length;
  const nError = results.filter(r => r.status === 'error').length;

  console.log('');
  log.info('════════════════════════════════════════════════════════');
  log.info(`SUMMARY   ${nOk} ok  /  ${nError} errors  /  ${results.length} total`);
  log.info(`CSV       ${csvPath}`);
  log.info(`Output    ${OUT_DIR}`);
  log.info('════════════════════════════════════════════════════════');
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
