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
 * Usage:
 *   node index.mjs
 *   node index.mjs --drive-folder 1AbCdEfGhIjKlMnOpQrStUvWxYz
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI    from 'openai';
import * as dotenv from 'dotenv';
import { readdirSync, existsSync, mkdirSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { basename, extname, join }     from 'path';
import { fileURLToPath }               from 'url';

import { extractAudio }   from './src/audio.mjs';
import { transcribe }     from './src/transcribe.mjs';
import { evaluate }       from './src/evaluate.mjs';
import {
  ensureStudentDir,
  writeTranscript,
  writeEvaluation,
  writeFeedback,
} from './src/report.mjs';
import { authorise, listVideos, downloadVideo } from './src/drive.mjs';

dotenv.config();

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname  = fileURLToPath(new URL('.', import.meta.url));
const INPUT_DIR  = join(__dirname, 'input_videos');
const OUTPUT_DIR = join(__dirname, 'output');
const TMP_DIR    = join(__dirname, 'tmp');

for (const dir of [INPUT_DIR, OUTPUT_DIR, TMP_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Local video extensions ────────────────────────────────────────────────────
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm']);

// ── Logger ────────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 19); }
const log = {
  info:  msg => console.log( `[INFO]  ${ts()}  ${msg}`),
  ok:    msg => console.log( `[OK]    ${ts()}  ${msg}`),
  warn:  msg => console.warn(`[WARN]  ${ts()}  ${msg}`),
  error: msg => console.error(`[ERROR] ${ts()}  ${msg}`),
  sep:   ()  => console.log( `        ${'─'.repeat(52)}`),
};

// ── CLI args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args   = argv.slice(2);
  const opts   = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--drive-folder' && args[i + 1]) {
      opts.driveFolderId = args[++i];
    }
  }

  // env var fallback
  opts.driveFolderId ??= process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  return opts;
}

// ── Video source: local ───────────────────────────────────────────────────────
function collectLocalVideos() {
  const files = readdirSync(INPUT_DIR)
    .filter(f => VIDEO_EXTS.has(extname(f).toLowerCase()))
    .sort();

  return files.map(f => ({
    videoPath: join(INPUT_DIR, f),
    student:   basename(f, extname(f)),
    cleanup:   null,           // nothing to clean up for local files
  }));
}

// ── Video source: Google Drive ────────────────────────────────────────────────
async function collectDriveVideos(folderId) {
  const auth = await authorise(log);

  log.info(`[Drive] Listing videos in folder: ${folderId}`);
  const files = await listVideos(folderId, auth);

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
    await downloadVideo(file.id, file.name, TMP_DIR, auth, bytes => {
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

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvField(value) {
  const s = String(value ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

async function writeCsv(results, rubric) {
  const criteriaIds = rubric.criteria.map(c => c.id);
  const header = ['student', 'score', 'grade', 'status', ...criteriaIds, 'error'].join(',');

  const rows = results.map(r => {
    if (r.status === 'error') {
      return [
        csvField(r.student), '', '', 'error',
        ...criteriaIds.map(() => ''),
        csvField(r.error),
      ].join(',');
    }

    const scoreMap = Object.fromEntries(
      r.evaluation.criteria.map(c => [c.id, c.score])
    );
    return [
      csvField(r.student),
      r.evaluation.weightedScore,
      csvField(r.evaluation.grade),
      'ok',
      ...criteriaIds.map(id => scoreMap[id] ?? ''),
      '',
    ].join(',');
  });

  const csv     = [header, ...rows].join('\n');
  const csvPath = join(OUTPUT_DIR, 'results.csv');
  await writeFile(csvPath, csv, 'utf8');
  return csvPath;
}

// ── Single-video pipeline ─────────────────────────────────────────────────────
async function processVideo(videoPath, student, anthropic, openai, rubric) {
  const audioPath  = join(TMP_DIR, `${student}_${Date.now()}.mp3`);
  const studentDir = ensureStudentDir(OUTPUT_DIR, student);

  try {
    // 1. Extract audio
    log.info(`[${student}] Extracting audio…`);
    await extractAudio(videoPath, audioPath);

    // 2. Transcribe
    log.info(`[${student}] Transcribing (Whisper, lang=ca)…`);
    const transcript = await transcribe(audioPath, openai);

    if (!transcript.text?.trim()) {
      throw new Error('Transcription is empty — does the video have audio?');
    }

    await writeTranscript(studentDir, transcript.text);
    log.info(`[${student}] transcript_ca.txt saved (${transcript.text.length} chars).`);

    // 3. Evaluate
    log.info(`[${student}] Evaluating with Claude…`);
    const evaluation = await evaluate(transcript, rubric, anthropic);
    evaluation.evaluatedAt = new Date().toISOString();

    // 4. Write output files
    await writeEvaluation(studentDir, evaluation);
    await writeFeedback(studentDir, evaluation);

    log.ok(`[${student}] Done — score: ${evaluation.weightedScore}/10  (${evaluation.grade})`);
    return evaluation;

  } finally {
    try { await unlink(audioPath); } catch { /* already gone or never created */ }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { driveFolderId } = parseArgs(process.argv);

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

  // ── Load rubric ─────────────────────────────────────────────────────────────
  const rubric = JSON.parse(
    await readFile(join(__dirname, 'rubric.json'), 'utf8')
  );

  // ── Init API clients ────────────────────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ── Collect videos ──────────────────────────────────────────────────────────
  let entries;

  if (driveFolderId) {
    log.info(`Source: Google Drive (folder: ${driveFolderId})`);
    entries = await collectDriveVideos(driveFolderId);
  } else {
    log.info('Source: local input_videos/');
    entries = collectLocalVideos();
  }

  if (entries.length === 0) {
    if (!driveFolderId) {
      log.warn('No video files found in input_videos/.');
      log.warn('Add .mp4 / .mov / .mkv / .avi / .webm files, or use --drive-folder <id>.');
    }
    process.exit(0);
  }

  log.info(`Processing ${entries.length} video(s)…`);
  log.sep();

  // ── Process each video ──────────────────────────────────────────────────────
  const results = [];

  for (const { videoPath, student, cleanup } of entries) {
    try {
      const evaluation = await processVideo(
        videoPath, student, anthropic, openai, rubric
      );
      results.push({ student, status: 'ok', evaluation });
    } catch (err) {
      log.error(`[${student}] Failed: ${err.message}`);
      results.push({ student, status: 'error', error: err.message });
    } finally {
      await cleanup?.();     // remove Drive-downloaded file after processing
    }
    log.sep();
  }

  // ── Write CSV ───────────────────────────────────────────────────────────────
  const csvPath = await writeCsv(results, rubric);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const nOk    = results.filter(r => r.status === 'ok').length;
  const nError = results.filter(r => r.status === 'error').length;

  console.log('');
  log.info('════════════════════════════════════════════════════════');
  log.info(`SUMMARY   ${nOk} ok  /  ${nError} errors  /  ${results.length} total`);
  log.info(`CSV       ${csvPath}`);
  log.info(`Output    ${OUTPUT_DIR}`);
  log.info('════════════════════════════════════════════════════════');
}

main().catch(err => {
  log.error(err.message);
  process.exit(1);
});
