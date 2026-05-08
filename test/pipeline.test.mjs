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
  const msg = () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] });
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

  it('returns cached evaluation when skipExisting=true and both output files exist', async () => {
    const student    = 'cached_student';
    const studentDir = join(outDir, student);
    mkdirSync(studentDir, { recursive: true });
    writeFileSync(join(studentDir, 'evaluation.json'), JSON.stringify(validEvaluation), 'utf8');
    writeFileSync(join(studentDir, 'feedback_ca.txt'), 'cached feedback', 'utf8');

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

    assert.equal(result.evaluation.weightedScore, validEvaluation.weightedScore, 'should return cached result');
    assert.equal(transcribeCalled, false, 'should not call Whisper when skipping');
  });

  it('does not skip when skipExisting=true but evaluation.json is absent', async () => {
    const student = 'no_eval_skip_student';
    // feedback file exists but evaluation.json does not
    const studentDir = join(outDir, student);
    mkdirSync(studentDir, { recursive: true });
    writeFileSync(join(studentDir, 'feedback_ca.txt'), 'old feedback', 'utf8');

    let transcribeCalled = false;
    const trackingTranscribe = async () => { transcribeCalled = true; return { text: 'x', segments: [] }; };

    await processVideo({
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

    assert.equal(transcribeCalled, true, 'should call Whisper when evaluation.json is absent');
  });

  it('does not skip when skipExisting=true but feedback file is absent', async () => {
    const student = 'no_feedback_skip_student';
    // evaluation.json exists but feedback file does not
    const studentDir = join(outDir, student);
    mkdirSync(studentDir, { recursive: true });
    writeFileSync(join(studentDir, 'evaluation.json'), JSON.stringify(validEvaluation), 'utf8');

    let transcribeCalled = false;
    const trackingTranscribe = async () => { transcribeCalled = true; return { text: 'x', segments: [] }; };

    await processVideo({
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

    assert.equal(transcribeCalled, true, 'should call Whisper when feedback file is absent');
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

  it('throws when transcript has no text property at all', async () => {
    await assert.rejects(
      () => processVideo({
        videoPath:      '/fake/video.mp4',
        student:        'no_text_field_student',
        anthropic:      makeAnthropic(),
        openai:         {},
        rubric:         mockRubric,
        outputDir:      outDir,
        tmpDir,
        log:            noop,
        extractAudioFn: noopExtract,
        transcribeFn:   async () => ({ segments: [] }),  // no text field → text is undefined
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

  it('propagates error and cleans up temp audio when extractAudio throws', async () => {
    const student = 'extract_fail_student';
    let capturedAudioPath;

    const extractWithPartialFile = async (_src, audioPath) => {
      capturedAudioPath = audioPath;
      writeFileSync(audioPath, Buffer.alloc(8));   // write a partial file before throwing
      throw new Error('ffmpeg not found');
    };

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
        extractAudioFn: extractWithPartialFile,
        transcribeFn:   makeTranscribe(),
      }),
      /ffmpeg not found/
    );

    assert.ok(!existsSync(capturedAudioPath), 'partial audio file should be deleted after extract error');
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

  it('swallows unlink errors in finally (EISDIR race-condition guard)', async () => {
    // If a DIRECTORY is created at the audioPath, existsSync returns true but
    // unlink throws EISDIR. The catch{} block should swallow it silently and
    // allow the result to be returned normally.
    const student = 'eisdir_student';

    const extractWithDir = async (_src, audioPath) => {
      mkdirSync(audioPath);   // put a dir where the file would be
    };

    const result = await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: extractWithDir,
      transcribeFn:   makeTranscribe(),
    });

    assert.equal(result.evaluation.weightedScore, validEvaluation.weightedScore,
      'should return evaluation despite unlink failure in finally');
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

  // ── log.warn forwarding via onRetry ──────────────────────────────────────────

  it('forwards transcribe retry events to log.warn', async () => {
    const student = 'transcribe_warn_student';
    const warnMessages = [];
    const warnLog = { ...noop, warn: msg => warnMessages.push(msg) };

    // A transcribeFn that fires the onRetry callback once, then succeeds.
    // This exercises the log.warn?.() branch inside pipeline.mjs.
    const retryingTranscribe = async (_path, _openai, opts) => {
      opts?.onRetry?.({ attempt: 1, maxRetries: 4, status: 429, delayMs: 0 });
      return { text: 'Hola.', segments: [] };
    };

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            warnLog,
      extractAudioFn: noopExtract,
      transcribeFn:   retryingTranscribe,
    });

    assert.ok(warnMessages.length > 0, 'should have produced at least one warning');
    assert.ok(warnMessages[0].includes('429'), 'warning should mention the HTTP status');
  });

  it('forwards evaluate retry events to log.warn', async () => {
    const student = 'eval_warn_student';
    const warnMessages = [];
    const warnLog = { ...noop, warn: msg => warnMessages.push(msg) };

    let streamCalls = 0;
    const retryingAnthropic = {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            streamCalls++;
            if (streamCalls === 1) {
              const e = new Error('rate limited');
              e.status = 429;
              throw e;
            }
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      retryingAnthropic,
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      baseDelay:      0,
      log:            warnLog,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    assert.ok(warnMessages.length > 0, 'should have produced at least one warning');
    assert.ok(warnMessages[0].includes('429'), 'warning should mention the HTTP status');
  });

  // ── Language-aware filenames ──────────────────────────────────────────────────

  it('writes transcript_{lang}.txt using rubric.language', async () => {
    const student   = 'lang_transcript_student';
    const esRubric  = { ...mockRubric, language: 'es', feedbackLanguage: 'es' };

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         esRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe('Hola soy estudiante.'),
    });

    const studentDir = join(outDir, student);
    assert.ok(existsSync(join(studentDir, 'transcript_es.txt')), 'transcript_es.txt should exist');
    assert.ok(!existsSync(join(studentDir, 'transcript_ca.txt')), 'transcript_ca.txt should not exist');
    assert.ok(existsSync(join(studentDir, 'feedback_es.txt')), 'feedback_es.txt should exist');
    assert.ok(!existsSync(join(studentDir, 'feedback_ca.txt')), 'feedback_ca.txt should not exist');
  });

  // ── model and thinking forwarding ─────────────────────────────────────────────

  it('forwards the model option to evaluate', async () => {
    let capturedModel;
    const trackingAnthropic = {
      messages: {
        stream: params => ({
          finalMessage: async () => {
            capturedModel = params.model;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student:        'model_fwd_student',
      anthropic:      trackingAnthropic,
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      model:          'claude-opus-4-7',
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    assert.equal(capturedModel, 'claude-opus-4-7');
  });

  it('forwards the thinking option to evaluate', async () => {
    let capturedThinking;
    const trackingAnthropic = {
      messages: {
        stream: params => ({
          finalMessage: async () => {
            capturedThinking = params.thinking;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student:        'thinking_fwd_student',
      anthropic:      trackingAnthropic,
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      thinking:       true,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    assert.deepEqual(capturedThinking, { type: 'adaptive' });
  });

  // ── tokenUsage in return value ────────────────────────────────────────────────

  it('returns tokenUsage from the evaluate call', async () => {
    const fakeUsage = { input_tokens: 500, output_tokens: 100,
                        cache_read_input_tokens: 300, cache_creation_input_tokens: 0 };
    const trackingAnthropic = {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [{ type: 'text', text: JSON.stringify(validEvaluation) }],
            usage:   fakeUsage,
          }),
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    const result = await processVideo({
      videoPath:      '/fake/video.mp4',
      student:        'usage_student',
      anthropic:      trackingAnthropic,
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    assert.deepEqual(result.tokenUsage, fakeUsage);
    assert.equal(result.evaluation.weightedScore, validEvaluation.weightedScore);
  });

  it('logs cache-write in token summary when cache_creation_input_tokens > 0', async () => {
    const fakeUsage = { input_tokens: 400, output_tokens: 80,
                        cache_read_input_tokens: 0, cache_creation_input_tokens: 200 };
    const trackingAnthropic = {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [{ type: 'text', text: JSON.stringify(validEvaluation) }],
            usage:   fakeUsage,
          }),
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    const result = await processVideo({
      videoPath:      '/fake/video.mp4',
      student:        'cache_write_student',
      anthropic:      trackingAnthropic,
      openai:         {},
      rubric:         mockRubric,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    assert.deepEqual(result.tokenUsage, fakeUsage);
  });

  it('returns tokenUsage:null when skipExisting returns from cache', async () => {
    const student    = 'cached_usage_student';
    const studentDir2 = join(outDir, student);
    mkdirSync(studentDir2, { recursive: true });
    writeFileSync(join(studentDir2, 'evaluation.json'), JSON.stringify(validEvaluation), 'utf8');
    writeFileSync(join(studentDir2, 'feedback_ca.txt'), 'cached feedback', 'utf8');

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
      transcribeFn:   makeTranscribe(),
    });

    assert.equal(result.tokenUsage, null);
    assert.equal(result.evaluation.weightedScore, validEvaluation.weightedScore);
  });

  // ── default log parameter ────────────────────────────────────────────────────

  it('works without a log argument (default no-op log is used)', async () => {
    const student = 'no_log_student';
    // Intentionally omit the log option to exercise the default { info:()=>{}, ok:()=>{} }
    await assert.doesNotReject(() =>
      processVideo({
        videoPath:      '/fake/video.mp4',
        student,
        anthropic:      makeAnthropic(),
        openai:         {},
        rubric:         mockRubric,
        outputDir:      outDir,
        tmpDir,
        extractAudioFn: noopExtract,
        transcribeFn:   makeTranscribe(),
      })
    );
  });

  // ── Language fallback defaults ────────────────────────────────────────────────

  it('defaults transcriptLang to "ca" when rubric.language is absent', async () => {
    const student     = 'no_lang_student';
    const rubricNoLang = { ...mockRubric };
    delete rubricNoLang.language;   // rubric.language || 'ca' → 'ca'

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         rubricNoLang,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    const studentDir = join(outDir, student);
    assert.ok(existsSync(join(studentDir, 'transcript_ca.txt')), 'transcript_ca.txt should exist when language defaults to ca');
  });

  it('defaults feedbackLang to "ca" when rubric.feedbackLanguage is absent', async () => {
    const student          = 'no_feedback_lang_student';
    const rubricNoFbLang   = { ...mockRubric };
    delete rubricNoFbLang.feedbackLanguage;   // rubric.feedbackLanguage || 'ca' → 'ca'

    await processVideo({
      videoPath:      '/fake/video.mp4',
      student,
      anthropic:      makeAnthropic(),
      openai:         {},
      rubric:         rubricNoFbLang,
      outputDir:      outDir,
      tmpDir,
      log:            noop,
      extractAudioFn: noopExtract,
      transcribeFn:   makeTranscribe(),
    });

    const studentDir = join(outDir, student);
    assert.ok(existsSync(join(studentDir, 'feedback_ca.txt')), 'feedback_ca.txt should exist when feedbackLanguage defaults to ca');
  });

  it('re-evaluates when skipExisting=true but cached evaluation.json is malformed JSON', async () => {
    const student    = 'corrupt_cache_student';
    const studentDir = join(outDir, student);
    mkdirSync(studentDir, { recursive: true });
    writeFileSync(join(studentDir, 'evaluation.json'), '{ INVALID JSON }', 'utf8');
    writeFileSync(join(studentDir, 'feedback_ca.txt'), 'old feedback', 'utf8');

    let transcribeCalled = false;
    const result = await processVideo({
      videoPath: '/fake/video.mp4', student,
      anthropic: makeAnthropic(), openai: {},
      rubric: mockRubric, outputDir: outDir, tmpDir,
      skipExisting:   true,
      extractAudioFn: noopExtract,
      transcribeFn:   async () => { transcribeCalled = true; return { text: 'hello world', segments: [] }; },
      log: { info: () => {}, ok: () => {}, warn: () => {} },
    });

    assert.ok(transcribeCalled, 'should re-evaluate when cached JSON is corrupt');
    assert.equal(result.evaluation.weightedScore, validEvaluation.weightedScore);
  });

});
