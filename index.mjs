/**
 * UOC Video Evaluator — Batch Orchestrator
 *
 * Sources (mutually exclusive, Drive takes precedence):
 *   --drive-folder <id>   or  GOOGLE_DRIVE_FOLDER_ID=<id>  → download from Drive
 *   (default)                                               → read from input_videos/
 *
 * Per-student output (output/<student>/):
 *   transcript_{lang}.txt  — Whisper transcript (lang from rubric.language)
 *   evaluation.json        — Claude's structured evaluation
 *   feedback_{lang}.txt    — Human-readable feedback (lang from rubric.feedbackLanguage)
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
import { readFile }                    from 'fs/promises';
import { join }                        from 'path';
import { fileURLToPath }               from 'url';

import { validateRubric }    from './src/validate.mjs';
import { processVideo }      from './src/pipeline.mjs';
import { writeCsv, rebuildCsv } from './src/report.mjs';
import { collectLocalVideos, collectDriveVideos } from './src/source.mjs';
import { authorise, createDriveClient } from './src/drive.mjs';
import { runBatch } from './src/batch.mjs';
import { parseArgs, USAGE } from './src/cli.mjs';

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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { driveFolderId, model, thinking, skipExisting, concurrency, outputDir,
          dryRun, rebuildCsv: doRebuild, version, help } =
    parseArgs(process.argv, flag => log.warn(`Unknown flag ignored: ${flag}`));

  if (version) {
    const pkg = JSON.parse(await readFile(join(__dirname, 'package.json'), 'utf8'));
    console.log(`${pkg.name} ${pkg.version}`);
    process.exit(0);
  }
  if (help) { console.log(USAGE); process.exit(0); }

  const OUT_DIR = outputDir ? outputDir : OUTPUT_DIR;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // ── Load and validate rubric (before env-var check — no API needed for this)
  const rubricPath = join(__dirname, 'rubric.json');
  if (!existsSync(rubricPath)) {
    log.error('rubric.json not found in project root. Create it to define your evaluation criteria.');
    process.exit(1);
  }
  const rubric = JSON.parse(await readFile(rubricPath, 'utf8'));
  try {
    validateRubric(rubric);
  } catch (err) {
    log.error(`Invalid rubric.json: ${err.message}`);
    process.exit(1);
  }

  // ── Rebuild CSV from existing evaluation.json files ────────────────────────
  if (doRebuild) {
    log.info(`[REBUILD] Scanning ${OUT_DIR} for evaluation.json files…`);
    const csvPath = await rebuildCsv(OUT_DIR, rubric);
    log.ok(`[REBUILD] CSV written → ${csvPath}`);
    process.exit(0);
  }

  // ── Collect videos ──────────────────────────────────────────────────────────
  let entries;

  if (driveFolderId) {
    log.info(`Source: Google Drive (folder: ${driveFolderId})`);
    const auth  = await authorise(log);
    const drive = createDriveClient(auth);
    entries = await collectDriveVideos(driveFolderId, drive, { tmpDir: TMP_DIR, log });
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

  log.info(`Processing ${entries.length} video(s) — concurrency: ${concurrency}  model: ${model}${thinking ? '  thinking: on' : ''}`);
  log.sep();

  // ── Process videos (bounded concurrency) ───────────────────────────────────
  const batchStart = Date.now();
  const total = entries.length;
  const results = await runBatch(
    entries,
    async ({ videoPath, student, cleanup }, idx) => {
      log.info(`[${idx + 1}/${total}] Starting ${student}`);
      try {
        const evaluation = await processVideo({
          videoPath, student, anthropic, openai, rubric,
          model, thinking, skipExisting, outputDir: OUT_DIR, tmpDir: TMP_DIR, log,
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
  const nOk      = results.filter(r => r.status === 'ok').length;
  const nError   = results.filter(r => r.status === 'error').length;
  const elapsedS = ((Date.now() - batchStart) / 1000).toFixed(1);

  console.log('');
  log.info('════════════════════════════════════════════════════════');
  log.info(`SUMMARY   ${nOk} ok  /  ${nError} errors  /  ${results.length} total`);
  log.info(`Elapsed   ${elapsedS}s`);
  log.info(`CSV       ${csvPath}`);
  log.info(`Output    ${OUT_DIR}`);
  log.info('════════════════════════════════════════════════════════');
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
