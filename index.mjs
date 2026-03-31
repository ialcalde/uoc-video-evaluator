/**
 * UOC Video Evaluator — Batch Orchestrator
 *
 * Reads every video in input_videos/, runs the full pipeline for each student,
 * and writes per-student output files plus a consolidated results.csv.
 *
 * Per-student output (output/<student>/):
 *   transcript_ca.txt   — Catalan transcript from Whisper
 *   evaluation.json     — Claude's structured evaluation
 *   feedback_ca.txt     — Human-readable feedback in Catalan
 *
 * Consolidated output:
 *   output/results.csv  — One row per student
 *
 * Usage:
 *   node index.mjs
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI    from 'openai';
import * as dotenv from 'dotenv';
import { readdirSync, existsSync, mkdirSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { basename, extname, join } from 'path';
import { fileURLToPath } from 'url';

import { extractAudio }   from './src/audio.mjs';
import { transcribe }     from './src/transcribe.mjs';
import { evaluate }       from './src/evaluate.mjs';
import {
  ensureStudentDir,
  writeTranscript,
  writeEvaluation,
  writeFeedback,
} from './src/report.mjs';

dotenv.config();

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname  = fileURLToPath(new URL('.', import.meta.url));
const INPUT_DIR  = join(__dirname, 'input_videos');
const OUTPUT_DIR = join(__dirname, 'output');
const TMP_DIR    = join(__dirname, 'tmp');

for (const dir of [INPUT_DIR, OUTPUT_DIR, TMP_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Accepted video extensions ─────────────────────────────────────────────────
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

    const scoreMap = Object.fromEntries(r.evaluation.criteria.map(c => [c.id, c.score]));
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

    log.ok(
      `[${student}] Done — score: ${evaluation.weightedScore}/10  (${evaluation.grade})`
    );

    return evaluation;
  } finally {
    // Always remove the temp audio file
    try { await unlink(audioPath); } catch { /* already gone or never created */ }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Validate environment variables
  const missingKeys = [];
  if (!process.env.ANTHROPIC_API_KEY) missingKeys.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missingKeys.push('OPENAI_API_KEY');
  if (missingKeys.length) {
    log.error(`Missing environment variables: ${missingKeys.join(', ')}`);
    log.error('Copy .env.example to .env and fill in your keys.');
    process.exit(1);
  }

  // Load rubric
  const rubric = JSON.parse(
    await readFile(join(__dirname, 'rubric.json'), 'utf8')
  );

  // Init API clients
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Discover video files
  let videoFiles;
  try {
    videoFiles = readdirSync(INPUT_DIR)
      .filter(f => VIDEO_EXTS.has(extname(f).toLowerCase()))
      .sort()
      .map(f => join(INPUT_DIR, f));
  } catch {
    log.error('Cannot read input_videos/ directory.');
    process.exit(1);
  }

  if (videoFiles.length === 0) {
    log.warn('No video files found in input_videos/.');
    log.warn('Add .mp4 / .mov / .mkv / .avi / .webm files and run again.');
    process.exit(0);
  }

  log.info(`Found ${videoFiles.length} video(s) in input_videos/.`);
  log.sep();

  // Process each video — errors are caught per file so the batch continues
  const results = [];

  for (const videoPath of videoFiles) {
    const student = basename(videoPath, extname(videoPath));
    try {
      const evaluation = await processVideo(
        videoPath, student, anthropic, openai, rubric
      );
      results.push({ student, status: 'ok', evaluation });
    } catch (err) {
      log.error(`[${student}] Failed: ${err.message}`);
      results.push({ student, status: 'error', error: err.message });
    }
    log.sep();
  }

  // Write consolidated CSV
  const csvPath = await writeCsv(results, rubric);

  // Final summary
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
