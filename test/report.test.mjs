import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureStudentDir,
  writeTranscript,
  writeEvaluation,
  writeFeedback,
  writeCsv,
  rebuildCsv,
  csvField,
} from '../src/report.mjs';
import { mockRubric, validEvaluation } from './fixtures.mjs';

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
    await writeTranscript(dir, text, 'ca');

    const content = await readFile(join(dir, 'transcript_ca.txt'), 'utf8');
    assert.equal(content, text);
  });

  it('writeTranscript uses lang code in filename', async () => {
    const dir = ensureStudentDir(tmpBase, 'transcript_en_student');
    await writeTranscript(dir, 'Hello world', 'en');
    assert.ok(existsSync(join(dir, 'transcript_en.txt')), 'should create transcript_en.txt');
    assert.ok(!existsSync(join(dir, 'transcript_ca.txt')), 'should not create transcript_ca.txt');
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
    await writeFeedback(dir, validEvaluation, 'ca');

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

  it('feedback file includes rubric title and student name in the header', async () => {
    const dir = ensureStudentDir(tmpBase, 'feedback_header_student');
    await writeFeedback(dir, validEvaluation, 'ca');

    const content = await readFile(join(dir, 'feedback_ca.txt'), 'utf8');
    assert.ok(content.includes(validEvaluation.rubricTitle), 'should include rubric title');
    assert.ok(content.includes('feedback_header_student'),   'should include student name from directory');
  });

  it('includes each criterion name and justification in feedback_ca.txt', async () => {
    const dir = ensureStudentDir(tmpBase, 'feedback_criteria_student');
    await writeFeedback(dir, validEvaluation, 'ca');

    const content = await readFile(join(dir, 'feedback_ca.txt'), 'utf8');

    for (const c of validEvaluation.criteria) {
      assert.ok(content.includes(c.justification), `missing justification for ${c.id}`);
    }
  });

  it('writeFeedback uses lang code in filename and localises headings', async () => {
    const dir = ensureStudentDir(tmpBase, 'feedback_en_student');
    await writeFeedback(dir, validEvaluation, 'en');

    assert.ok(existsSync(join(dir, 'feedback_en.txt')), 'should create feedback_en.txt');
    assert.ok(!existsSync(join(dir, 'feedback_ca.txt')), 'should not create feedback_ca.txt');

    const content = await readFile(join(dir, 'feedback_en.txt'), 'utf8');
    assert.ok(content.includes('OVERALL FEEDBACK'), 'English heading should appear');
    assert.ok(content.includes('CRITERIA DETAIL'),  'English heading should appear');
    assert.ok(content.includes(validEvaluation.overallFeedback), 'feedback text should appear');
  });

  it('writeFeedback aligns header columns consistently for Spanish (long labels)', async () => {
    const dir = ensureStudentDir(tmpBase, 'feedback_es_student');
    await writeFeedback(dir, validEvaluation, 'es');

    const content = await readFile(join(dir, 'feedback_es.txt'), 'utf8');
    const headerLines = content.split('\n').slice(0, 5);

    // Every header line should contain ' : ' at the same position
    const colonPositions = headerLines.map(line => line.indexOf(' : '));
    const allSame = colonPositions.every(p => p === colonPositions[0]);
    assert.ok(allSame, `Columns not aligned — ' : ' positions: ${colonPositions.join(', ')}`);

    // The longest Spanish label is 'Fecha de evaluación' (19 chars); colW = 21
    assert.ok(colonPositions[0] >= 19, 'column separator should be after the longest label');
  });

  it('writeFeedback handles undefined evaluatedAt without writing "undefined"', async () => {
    const dir = ensureStudentDir(tmpBase, 'no_date_student');
    const evalWithoutDate = { ...validEvaluation };
    delete evalWithoutDate.evaluatedAt;
    await writeFeedback(dir, evalWithoutDate, 'ca');
    const content = await readFile(join(dir, 'feedback_ca.txt'), 'utf8');
    assert.ok(!content.includes('undefined'), 'should not write the string "undefined" to file');
    assert.ok(content.includes(validEvaluation.overallFeedback), 'should still write feedback');
  });

  it('writeFeedback falls back to English headings for unknown lang', async () => {
    const dir = ensureStudentDir(tmpBase, 'feedback_de_student');
    await writeFeedback(dir, validEvaluation, 'de');

    const content = await readFile(join(dir, 'feedback_de.txt'), 'utf8');
    assert.ok(content.includes('OVERALL FEEDBACK'), 'should fall back to English heading');
  });

  // ── csvField ────────────────────────────────────────────────────────────────

  it('csvField: plain text is returned as-is', () => {
    assert.equal(csvField('hello'), 'hello');
    assert.equal(csvField(7.5),     '7.5');
    assert.equal(csvField(null),    '');
    assert.equal(csvField(undefined), '');
  });

  it('csvField: strings with commas are double-quoted', () => {
    assert.equal(csvField('Notable (B), aprovat'), '"Notable (B), aprovat"');
  });

  it('csvField: embedded double-quotes are escaped', () => {
    assert.equal(csvField('She said "hi"'), '"She said ""hi"""');
  });

  it('csvField: strings with newlines are double-quoted', () => {
    const result = csvField('line1\nline2');
    assert.match(result, /^"/);
    assert.match(result, /"$/);
  });

  // ── writeCsv ────────────────────────────────────────────────────────────────

  it('writeCsv: creates results.csv with header and one ok row', async () => {
    const results = [{ student: 'maria_lopez', status: 'ok', evaluation: validEvaluation }];
    const csvPath = await writeCsv(tmpBase, results, mockRubric);

    assert.ok(existsSync(csvPath));
    const raw   = await readFile(csvPath, 'utf8');
    const lines = raw.split('\n');

    // Header: student,score,grade,status,evaluatedAt,content_accuracy,oral_expression,overallFeedback,error
    assert.ok(lines[0].startsWith('student,score,grade,status'));
    assert.ok(lines[0].includes('evaluatedAt'),     'header should include evaluatedAt column');
    assert.ok(lines[0].includes('content_accuracy'));
    assert.ok(lines[0].includes('oral_expression'));
    assert.ok(lines[0].includes('overallFeedback'), 'header should include overallFeedback column');

    // Data row
    assert.ok(lines[1].includes('maria_lopez'));
    assert.ok(lines[1].includes(String(validEvaluation.weightedScore)));
    assert.ok(lines[1].includes('ok'));
  });

  it('writeCsv: ok rows include evaluatedAt from the evaluation object', async () => {
    const results = [{ student: 'ts_student', status: 'ok', evaluation: validEvaluation }];
    const csvPath = await writeCsv(tmpBase, results, mockRubric);
    const raw = await readFile(csvPath, 'utf8');
    assert.ok(raw.includes(validEvaluation.evaluatedAt),
      'evaluatedAt should appear in the data row');
  });

  it('writeCsv: ok rows include the overallFeedback text', async () => {
    const results = [{ student: 'test_student', status: 'ok', evaluation: validEvaluation }];
    const csvPath = await writeCsv(tmpBase, results, mockRubric);
    const raw = await readFile(csvPath, 'utf8');
    assert.ok(raw.includes(validEvaluation.overallFeedback.slice(0, 20)),
      'overallFeedback content should appear in the CSV row');
  });

  it('writeCsv: error rows have empty score/grade and a filled error column', async () => {
    const results = [{ student: 'joan_puig', status: 'error', error: 'ffmpeg not found' }];
    const csvPath = await writeCsv(tmpBase, results, mockRubric);

    const raw  = await readFile(csvPath, 'utf8');
    const row  = raw.split('\n')[1];

    assert.ok(row.includes('joan_puig'));
    assert.ok(row.includes('error'));
    assert.ok(row.includes('ffmpeg not found'));
  });

  it('writeCsv: student names containing commas are quoted', async () => {
    const results = [{
      student:    'Puig, Joan',
      status:     'ok',
      evaluation: validEvaluation,
    }];
    const csvPath = await writeCsv(tmpBase, results, mockRubric);
    const raw = await readFile(csvPath, 'utf8');

    assert.ok(raw.includes('"Puig, Joan"'));
  });

  it('writeCsv: ok rows handle undefined evaluatedAt and overallFeedback without writing "undefined"', async () => {
    const evalWithMissing = { ...validEvaluation, evaluatedAt: undefined, overallFeedback: undefined };
    const csvPath = await writeCsv(tmpBase, [{ student: 'sparse_ok_student', status: 'ok', evaluation: evalWithMissing }], mockRubric);
    const raw = await readFile(csvPath, 'utf8');
    assert.ok(!raw.includes('undefined'), 'should not write the string "undefined" to CSV');
    assert.ok(raw.includes('sparse_ok_student'));
  });

  it('writeCsv: emits empty cell when criterion id is absent from evaluation scoreMap', async () => {
    // Rubric references 'absent_crit' but the evaluation only has content_accuracy and oral_expression
    const extendedRubric = {
      ...mockRubric,
      criteria: [mockRubric.criteria[0], { ...mockRubric.criteria[1], id: 'absent_crit' }],
    };
    const csvPath = await writeCsv(tmpBase, [{ student: 'absent_crit_student', status: 'ok', evaluation: validEvaluation }], extendedRubric);
    const raw = await readFile(csvPath, 'utf8');
    const headerFields = raw.split('\n')[0].split(',');
    const absentIdx = headerFields.indexOf('absent_crit');
    assert.ok(absentIdx >= 0, 'header should include absent_crit column');
    const dataFields = raw.split('\n')[1].split(',');
    assert.equal(dataFields[absentIdx], '', 'absent criterion column should be empty string, not "undefined"');
  });

  it('writeCsv: returns the path of the written file', async () => {
    const csvPath = await writeCsv(tmpBase, [], mockRubric);
    assert.ok(csvPath.endsWith('results.csv'));
  });

  // ── rebuildCsv ──────────────────────────────────────────────────────────────

  it('rebuildCsv: picks up evaluation.json files from student sub-dirs', async () => {
    const rebuildBase = mkdtempSync(join(tmpdir(), 'uoc-rebuild-test-'));
    try {
      const dir = ensureStudentDir(rebuildBase, 'anna');
      await writeEvaluation(dir, validEvaluation);

      const { csvPath, count } = await rebuildCsv(rebuildBase, mockRubric);
      const raw = await readFile(csvPath, 'utf8');

      assert.equal(count, 1, 'should report 1 rebuilt evaluation');
      assert.ok(raw.includes('anna'));
      assert.ok(raw.includes(String(validEvaluation.weightedScore)));
    } finally {
      rmSync(rebuildBase, { recursive: true, force: true });
    }
  });

  it('rebuildCsv: ignores sub-dirs without evaluation.json', async () => {
    const rebuildBase = mkdtempSync(join(tmpdir(), 'uoc-rebuild-test-'));
    try {
      // One directory WITH eval, one WITHOUT
      const dirA = ensureStudentDir(rebuildBase, 'alice');
      await writeEvaluation(dirA, validEvaluation);
      ensureStudentDir(rebuildBase, 'bob');  // no evaluation.json

      const { csvPath, count } = await rebuildCsv(rebuildBase, mockRubric);
      const raw = await readFile(csvPath, 'utf8');
      const lines = raw.trim().split('\n');

      assert.equal(count, 1, 'should count only dirs with evaluation.json');
      assert.equal(lines.length, 2, 'header + 1 data row');
      assert.ok(raw.includes('alice'));
      assert.ok(!raw.includes('bob'));
    } finally {
      rmSync(rebuildBase, { recursive: true, force: true });
    }
  });

  it('rebuildCsv: returns results sorted alphabetically', async () => {
    const rebuildBase = mkdtempSync(join(tmpdir(), 'uoc-rebuild-test-'));
    try {
      for (const name of ['charlie', 'alice', 'bob']) {
        const d = ensureStudentDir(rebuildBase, name);
        await writeEvaluation(d, validEvaluation);
      }

      const { csvPath } = await rebuildCsv(rebuildBase, mockRubric);
      const raw = await readFile(csvPath, 'utf8');
      const dataLines = raw.trim().split('\n').slice(1);  // skip header

      assert.ok(dataLines[0].startsWith('alice'));
      assert.ok(dataLines[1].startsWith('bob'));
      assert.ok(dataLines[2].startsWith('charlie'));
    } finally {
      rmSync(rebuildBase, { recursive: true, force: true });
    }
  });

  it('rebuildCsv: silently skips student directories with malformed evaluation.json', async () => {
    const rebuildBase = mkdtempSync(join(tmpdir(), 'uoc-rebuild-test-'));
    try {
      // Malformed JSON file — rebuildCsv should skip it without throwing
      const badDir = ensureStudentDir(rebuildBase, 'malformed_student');
      writeFileSync(join(badDir, 'evaluation.json'), '{ not valid json }', 'utf8');

      // One valid evaluation alongside the bad one
      const goodDir = ensureStudentDir(rebuildBase, 'good_student');
      await writeEvaluation(goodDir, validEvaluation);

      const { csvPath, count } = await rebuildCsv(rebuildBase, mockRubric);
      const raw = await readFile(csvPath, 'utf8');

      assert.equal(count, 1, 'should count only valid evaluations');
      assert.ok(raw.includes('good_student'), 'valid student should appear in CSV');
      assert.ok(!raw.includes('malformed_student'), 'malformed student should be skipped');
    } finally {
      rmSync(rebuildBase, { recursive: true, force: true });
    }
  });

  it('rebuildCsv: skips non-directory entries (plain files) in outputDir', async () => {
    const rebuildBase = mkdtempSync(join(tmpdir(), 'uoc-rebuild-test-'));
    try {
      // A plain file in the output root should be silently skipped (not throw)
      writeFileSync(join(rebuildBase, 'stray-file.txt'), 'some content', 'utf8');

      const dir = ensureStudentDir(rebuildBase, 'real_student');
      await writeEvaluation(dir, validEvaluation);

      const { count } = await rebuildCsv(rebuildBase, mockRubric);
      assert.equal(count, 1, 'stray file should not count as a student');
    } finally {
      rmSync(rebuildBase, { recursive: true, force: true });
    }
  });

  it('rebuildCsv: returns count=0 when no evaluation.json files exist', async () => {
    const rebuildBase = mkdtempSync(join(tmpdir(), 'uoc-rebuild-test-'));
    try {
      const { csvPath, count } = await rebuildCsv(rebuildBase, mockRubric);
      const raw = await readFile(csvPath, 'utf8');
      const lines = raw.trim().split('\n');

      assert.equal(count, 0, 'count should be 0 for empty directory');
      assert.equal(lines.length, 1, 'only header row');
    } finally {
      rmSync(rebuildBase, { recursive: true, force: true });
    }
  });
});
