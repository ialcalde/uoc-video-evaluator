/**
 * UOC Video Evaluator
 *
 * Pipeline:
 *  1. Extract audio from the video with ffmpeg → tmp/<name>.mp3
 *  2. Transcribe audio with OpenAI Whisper
 *  3. Evaluate the transcript against rubric.json with Claude
 *  4. Write JSON + Markdown reports to output/
 *
 * Usage:
 *   node index.mjs <video_file> [--lang <language>] [--rubric <path>]
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { spawn } from 'child_process';
import { createReadStream, existsSync, mkdirSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { basename, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const TMP_DIR    = join(__dirname, 'tmp');

for (const dir of [OUTPUT_DIR, TMP_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── CLI args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { lang: 'ca', rubricPath: join(__dirname, 'rubric.json') };
  let videoPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang'   && args[i + 1]) { opts.lang       = args[++i]; }
    else if (args[i] === '--rubric' && args[i + 1]) { opts.rubricPath = args[++i]; }
    else if (!args[i].startsWith('--')) { videoPath = args[i]; }
  }

  if (!videoPath) {
    console.error('Usage: node index.mjs <video_file> [--lang <language>] [--rubric <path>]');
    process.exit(1);
  }

  return { videoPath: resolve(videoPath), ...opts };
}

// ── ffmpeg audio extraction ───────────────────────────────────────────────────
function extractAudio(videoPath, outputAudioPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',                     // overwrite
      '-i', videoPath,
      '-vn',                    // drop video stream
      '-ar', '16000',           // 16 kHz — optimal for Whisper
      '-ac', '1',               // mono
      '-c:a', 'libmp3lame',
      '-q:a', '4',
      outputAudioPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(outputAudioPath);
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr}`));
    });
    proc.on('error', err => reject(new Error(`ffmpeg not found: ${err.message}`)));
  });
}

// ── Whisper transcription ─────────────────────────────────────────────────────
async function transcribe(audioPath, lang, openai) {
  const stream = createReadStream(audioPath);
  const response = await openai.audio.transcriptions.create({
    file:     stream,
    model:    'whisper-1',
    language: lang,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });
  return response;
}

// ── Claude evaluation ─────────────────────────────────────────────────────────
async function evaluate(transcript, rubric, lang, anthropic) {
  const criteriaBlock = rubric.criteria.map(c =>
    `### ${c.id} — ${c.nameEn} (weight: ${c.weight}, max 10 pts)\n` +
    `${c.description}\n` +
    `Scoring levels:\n` +
    c.levels.map(l => `  - ${l.score}/10 (${l.label}): ${l.description}`).join('\n')
  ).join('\n\n');

  const systemPrompt = `You are an expert academic evaluator for the Universitat Oberta de Catalunya (UOC).
You evaluate student video presentations using the provided rubric.
Return ONLY a valid JSON object — no markdown fences, no extra text.`;

  const userPrompt = `# Rubric: ${rubric.title}

${criteriaBlock}

---

# Grading scale
${rubric.gradingScale.map(g => `${g.min}–${g.max}: ${g.label}`).join('\n')}

---

# Transcript (language: ${lang})
${transcript.text}

---

Evaluate the transcript against each rubric criterion.
For each criterion provide:
- score: number 0–10
- justification: 2–4 sentences in English referencing specific transcript evidence

Then compute:
- weightedScore: sum of (criterion.score × criterion.weight) for all criteria, rounded to 2 decimal places
- grade: matching label from the grading scale

Return this exact JSON shape:
{
  "rubricTitle": "<string>",
  "evaluatedAt": "<ISO 8601 timestamp>",
  "language": "<lang>",
  "criteria": [
    {
      "id": "<criterion id>",
      "name": "<criterion nameEn>",
      "weight": <number>,
      "score": <number 0-10>,
      "justification": "<string>"
    }
  ],
  "weightedScore": <number>,
  "grade": "<string>",
  "overallFeedback": "<3–5 sentence summary with one strength and one area for improvement>"
}`;

  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    messages:   [{ role: 'user', content: userPrompt }],
    system:     systemPrompt,
  });

  const raw = message.content[0].text.trim();
  return JSON.parse(raw);
}

// ── Report writers ────────────────────────────────────────────────────────────
function buildMarkdown(evaluation, videoName, transcript) {
  const lines = [
    `# Evaluation Report — ${videoName}`,
    '',
    `**Rubric:** ${evaluation.rubricTitle}  `,
    `**Evaluated at:** ${evaluation.evaluatedAt}  `,
    `**Language:** ${evaluation.language}  `,
    `**Overall score:** ${evaluation.weightedScore} / 10  `,
    `**Grade:** ${evaluation.grade}`,
    '',
    '---',
    '',
    '## Criteria',
    '',
  ];

  for (const c of evaluation.criteria) {
    const bar = '█'.repeat(Math.round(c.score)) + '░'.repeat(10 - Math.round(c.score));
    lines.push(`### ${c.name} (weight ${c.weight})`);
    lines.push(`**Score:** ${c.score}/10  \`${bar}\``);
    lines.push('');
    lines.push(c.justification);
    lines.push('');
  }

  lines.push('---', '', '## Overall Feedback', '');
  lines.push(evaluation.overallFeedback);
  lines.push('');
  lines.push('---', '', '## Transcript', '');
  lines.push(transcript.text);

  return lines.join('\n');
}

async function writeReports(evaluation, transcript, videoPath) {
  const stem = basename(videoPath, extname(videoPath)).replace(/\s+/g, '_');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = join(OUTPUT_DIR, `${stem}_${ts}`);

  const jsonPath = `${base}.json`;
  const mdPath   = `${base}.md`;

  const fullJson = { evaluation, transcript: { text: transcript.text, segments: transcript.segments } };

  await writeFile(jsonPath, JSON.stringify(fullJson, null, 2), 'utf8');
  await writeFile(mdPath,   buildMarkdown(evaluation, basename(videoPath), transcript), 'utf8');

  return { jsonPath, mdPath };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function cleanup(path) {
  try { await unlink(path); } catch { /* ignore */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { videoPath, lang, rubricPath } = parseArgs(process.argv);

  if (!existsSync(videoPath)) {
    console.error(`File not found: ${videoPath}`);
    process.exit(1);
  }

  const missingKeys = [];
  if (!process.env.ANTHROPIC_API_KEY) missingKeys.push('ANTHROPIC_API_KEY');
  if (!process.env.OPENAI_API_KEY)    missingKeys.push('OPENAI_API_KEY');
  if (missingKeys.length) {
    console.error(`Missing environment variables: ${missingKeys.join(', ')}\nCopy .env.example to .env and fill in your keys.`);
    process.exit(1);
  }

  const rubric    = JSON.parse(await readFile(rubricPath, 'utf8'));
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const videoName  = basename(videoPath);
  const audioStem  = basename(videoPath, extname(videoPath)).replace(/\s+/g, '_');
  const audioPath  = join(TMP_DIR, `${audioStem}_${Date.now()}.mp3`);

  // 1. Extract audio
  console.log(`[1/3] Extracting audio from "${videoName}"…`);
  await extractAudio(videoPath, audioPath);

  // 2. Transcribe
  console.log('[2/3] Transcribing with Whisper…');
  const transcript = await transcribe(audioPath, lang, openai);
  await cleanup(audioPath);

  if (!transcript.text?.trim()) {
    console.error('Transcription returned empty text. Is there audio in the video?');
    process.exit(1);
  }

  // 3. Evaluate
  console.log('[3/3] Evaluating with Claude…');
  const evaluation = await evaluate(transcript, rubric, lang, anthropic);
  evaluation.evaluatedAt = new Date().toISOString();

  // 4. Write reports
  const { jsonPath, mdPath } = await writeReports(evaluation, transcript, videoPath);

  // 5. Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${videoName}`);
  console.log(`  Score : ${evaluation.weightedScore} / 10`);
  console.log(`  Grade : ${evaluation.grade}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const c of evaluation.criteria) {
    const bar = '█'.repeat(Math.round(c.score)) + '░'.repeat(10 - Math.round(c.score));
    console.log(`  ${c.name.padEnd(24)} ${bar}  ${c.score}/10`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n  ${evaluation.overallFeedback}\n`);
  console.log(`  Reports saved to:`);
  console.log(`    ${mdPath}`);
  console.log(`    ${jsonPath}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
