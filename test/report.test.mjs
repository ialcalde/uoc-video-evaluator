import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureStudentDir,
  writeTranscript,
  writeEvaluation,
  writeFeedback,
} from '../src/report.mjs';
import { validEvaluation } from './fixtures.mjs';

describe('report', () => {
  let tmpBase;

  before(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'uoc-report-test-'));
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // ── ensureStudentDir ────────────────────────────────────────────────────────

  it('creates the student directory and returns its path', () => {
    const dir = ensureStudentDir(tmpBase, 'pau_garcia');
    assert.ok(existsSync(dir));
    assert.ok(dir.endsWith('pau_garcia'));
  });

  it('does not throw if the directory already exists', () => {
    ensureStudentDir(tmpBase, 'pau_garcia');   // first call
    assert.doesNotThrow(() => ensureStudentDir(tmpBase, 'pau_garcia'));
  });

  // ── writeTranscript ─────────────────────────────────────────────────────────

  it('writes the transcript text verbatim to transcript_ca.txt', async () => {
    const dir  = ensureStudentDir(tmpBase, 'transcript_student');
    const text = 'Hola, sóc estudiant de la UOC i avui presentaré el meu treball.';
    await writeTranscript(dir, text);

    const content = await readFile(join(dir, 'transcript_ca.txt'), 'utf8');
    assert.equal(content, text);
  });

  // ── writeEvaluation ─────────────────────────────────────────────────────────

  it('writes a valid JSON file to evaluation.json', async () => {
    const dir = ensureStudentDir(tmpBase, 'eval_student');
    await writeEvaluation(dir, validEvaluation);

    const raw    = await readFile(join(dir, 'evaluation.json'), 'utf8');
    const parsed = JSON.parse(raw);

    assert.equal(parsed.weightedScore, validEvaluation.weightedScore);
    assert.equal(parsed.grade, validEvaluation.grade);
    assert.equal(parsed.criteria.length, 2);
  });

  // ── writeFeedback ───────────────────────────────────────────────────────────

  it('writes feedback_ca.txt containing score, grade, and overallFeedback', async () => {
    const dir = ensureStudentDir(tmpBase, 'feedback_student');
    await writeFeedback(dir, validEvaluation);

    const content = await readFile(join(dir, 'feedback_ca.txt'), 'utf8');

    assert.ok(
      content.includes(String(validEvaluation.weightedScore)),
      'should include weighted score'
    );
    assert.ok(
      content.includes(validEvaluation.grade),
      'should include grade label'
    );
    assert.ok(
      content.includes(validEvaluation.overallFeedback),
      'should include overall feedback'
    );
  });

  it('includes each criterion name and justification in feedback_ca.txt', async () => {
    const dir = ensureStudentDir(tmpBase, 'feedback_criteria_student');
    await writeFeedback(dir, validEvaluation);

    const content = await readFile(join(dir, 'feedback_ca.txt'), 'utf8');

    for (const c of validEvaluation.criteria) {
      assert.ok(content.includes(c.justification), `missing justification for ${c.id}`);
    }
  });
});
