import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { processVideo } from '../src/pipeline.mjs';
import { mockRubric, validEvaluation } from './fixtures.mjs';

const noop = { info: () => {}, ok: () => {} };

// transcribeFn injection avoids createReadStream(audioPath) firing an async
// file-open after the test ends (which would cause "async activity after test" errors).
function makeTranscribe(text = 'Hola, sóc estudiant de la UOC.') {
  return async () => ({ text, segments: [] });
}

function makeAnthropic() {
  const msg = () => ({ content: [{ text: JSON.stringify(validEvaluation) }] });
  return {
    messages: {
      stream:  () => ({ finalMessage: async () => msg() }),
      create:  async () => msg(),
    },
  };
}

// noopExtract: stands in for ffmpeg — creates no audio file
const noopExtract = async () => {};

describe('processVideo', () => {
  let tmpDir, outDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uoc-pipeline-tmp-'));
    outDir = mkdtempSync(join(tmpdir(), 'uoc-pipeline-out-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  // ── skipExisting ─────────────────────────────────────────────────────────────

  it('returns cached evaluation when skipExisting=true and evaluation.json exists', async () => {
    const student    = 'cached_student';
    const studentDir = join(outDir, student);
    mkdirSync(studentDir, { recursive: true });
    writeFileSync(join(studentDir, 'evaluation.json'), JSON.stringify(validEvaluation), 'utf8');

    let transcribeCalled = false;
    const trackingTranscribe = async () => { transcribeCalled = true; return { text: 'x', segments: [] }; };

    const result = await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      skipExisting:   true,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   trackingTranscribe,
    });

    assert.equal(result.weightedScore, validEvaluation.weightedScore, 'should return cached result');
    assert.equal(transcribeCalled, false, 'should not call Whisper when skipping');
  });

  it('does not skip when skipExisting=false even if evaluation.json exists', async () => {
    const student    = 'no_skip_student';
    const studentDir = join(outDir, student);
    mkdirSync(studentDir, { recursive: true });
    writeFileSync(join(studentDir, 'evaluation.json'), JSON.stringify(validEvaluation), 'utf8');

    let transcribeCalled = false;
    const trackingTranscribe = async () => { transcribeCalled = true; return { text: 'Transcript.', segments: [] }; };

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      skipExisting:   false,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   trackingTranscribe,
    });

    assert.equal(transcribeCalled, true, 'should call Whisper when skipExisting=false');
  });

  // ── Full happy path ───────────────────────────────────────────────────────────

  it('writes transcript_ca.txt, evaluation.json, and feedback_ca.txt on success', async () => {
    const student = 'happy_student';

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    const studentDir = join(outDir, student);
    assert.ok(existsSync(join(studentDir, 'transcript_ca.txt')), 'transcript_ca.txt missing');
    assert.ok(existsSync(join(studentDir, 'evaluation.json')),  'evaluation.json missing');
    assert.ok(existsSync(join(studentDir, 'feedback_ca.txt')),  'feedback_ca.txt missing');
  });

  it('evaluation.json contains weightedScore, grade, and evaluatedAt', async () => {
    const student = 'eval_check_student';

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    const parsed = JSON.parse(await readFile(join(outDir, student, 'evaluation.json'), 'utf8'));
    assert.equal(parsed.weightedScore, validEvaluation.weightedScore);
    assert.equal(parsed.grade,         validEvaluation.grade);
    assert.ok(parsed.evaluatedAt,      'evaluatedAt should be set by processVideo');
  });

  it('transcript_ca.txt matches what transcribeFn returned', async () => {
    const student        = 'transcript_check_student';
    const transcriptText = 'Contingut específic de la presentació.';

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(transcriptText),
    });

    const content = await readFile(join(outDir, student, 'transcript_ca.txt'), 'utf8');
    assert.equal(content, transcriptText);
  });

  // ── Error handling ────────────────────────────────────────────────────────────

  it('throws when transcript text is empty', async () => {
    await assert.rejects(
      () => processVideo({
        videoPath:      '/fake/video.mp4',
        student:        'empty_transcript_student',
        anthropic:      makeAnthropic(),
        openai:         {},
        rubric:         mockRubric,
        outputDir:      outDir,
        tmpDir,
        log:            noop,
        extractAudioFn: noopExtract,
        transcribeFn:   makeTranscribe(''),
      }),
      /Transcription is empty/i
    );
  });

  it('throws when transcript text is only whitespace', async () => {
    await assert.rejects(
      () => processVideo({
        videoPath:      '/fake/video.mp4',
        student:        'whitespace_student',
        anthropic:      makeAnthropic(),
        openai:         {},
        rubric:         mockRubric,
        outputDir:      outDir,
        tmpDir,
        log:            noop,
        extractAudioFn: noopExtract,
        transcribeFn:   makeTranscribe('   \n  \t  '),
      }),
      /Transcription is empty/i
    );
  });

  it('cleans up the temp audio file when transcription fails', async () => {
    const student = 'cleanup_student';
    let capturedAudioPath;

    const extractWithFile = async (_src, audioPath) => {
      capturedAudioPath = audioPath;
      writeFileSync(audioPath, Buffer.alloc(8));
    };
    const failingTranscribe = async () => { throw new Error('Whisper unavailable'); };

    await assert.rejects(
      () => processVideo({
        videoPath:      '/fake/video.mp4',
        student,
        anthropic:      makeAnthropic(),
        openai:         {},
        rubric:         mockRubric,
        outputDir:      outDir,
        tmpDir,
        log:            noop,
        extractAudioFn: extractWithFile,
        transcribeFn:   failingTranscribe,
      }),
      /Whisper unavailable/
    );

    assert.ok(!existsSync(capturedAudioPath), 'temp audio file should be deleted after error');
  });

  it('does not leave temp audio files after a successful run', async () => {
    const student     = 'no_leak_student';
    const filesBefore = readdirSync(tmpDir);

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    const filesAfter = readdirSync(tmpDir);
    assert.equal(filesAfter.length, filesBefore.length, 'no new temp files after success');
  });

});
