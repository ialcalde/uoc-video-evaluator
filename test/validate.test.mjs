import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvaluation, validateRubric } from '../src/validate.mjs';
import { mockRubric, validEvaluation } from './fixtures.mjs';

// Helper: serialize to JSON string (what Claude actually returns)
const toRaw = obj => JSON.stringify(obj);

describe('validateEvaluation', () => {

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('returns the parsed object when input is valid', () => {
    const result = validateEvaluation(toRaw(validEvaluation), mockRubric);
    assert.equal(result.weightedScore, validEvaluation.weightedScore);
    assert.equal(result.grade, validEvaluation.grade);
    assert.equal(result.criteria.length, 2);
  });

  it('accepts integer scores', () => {
    const ev = { ...validEvaluation, criteria: validEvaluation.criteria.map(c => ({ ...c, score: 10 })) };
    assert.doesNotThrow(() => validateEvaluation(toRaw(ev), mockRubric));
  });

  it('accepts float scores within range', () => {
    const ev = { ...validEvaluation, criteria: validEvaluation.criteria.map(c => ({ ...c, score: 7.5 })) };
    assert.doesNotThrow(() => validateEvaluation(toRaw(ev), mockRubric));
  });

  // ── JSON parsing ────────────────────────────────────────────────────────────

  it('throws on malformed JSON', () => {
    assert.throws(
      () => validateEvaluation('{ not valid json }', mockRubric),
      /JSON malformat/
    );
  });

  it('includes the start of raw response in the error message', () => {
    try {
      validateEvaluation('broken', mockRubric);
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(err.message, /broken/);
    }
  });

  // ── Markdown fence stripping ────────────────────────────────────────────────

  it('parses JSON wrapped in ```json ... ``` code fences', () => {
    const fenced = `\`\`\`json\n${toRaw(validEvaluation)}\n\`\`\``;
    const result = validateEvaluation(fenced, mockRubric);
    assert.equal(result.weightedScore, validEvaluation.weightedScore);
  });

  it('parses JSON wrapped in plain ``` ... ``` code fences', () => {
    const fenced = `\`\`\`\n${toRaw(validEvaluation)}\n\`\`\``;
    const result = validateEvaluation(fenced, mockRubric);
    assert.equal(result.grade, validEvaluation.grade);
  });

  it('parses bare JSON without any code fences', () => {
    assert.doesNotThrow(() => validateEvaluation(toRaw(validEvaluation), mockRubric));
  });

  // ── Missing top-level fields ────────────────────────────────────────────────

  it('throws when "criteria" is missing', () => {
    const ev = { ...validEvaluation };
    delete ev.criteria;
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /criteria/
    );
  });

  it('throws when "overallFeedback" is missing', () => {
    const ev = { ...validEvaluation };
    delete ev.overallFeedback;
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /overallFeedback/i
    );
  });

  it('throws when "overallFeedback" is not a string', () => {
    const ev = { ...validEvaluation, overallFeedback: 42 };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /overallFeedback/i
    );
  });

  it('throws when "overallFeedback" is an empty string', () => {
    const ev = { ...validEvaluation, overallFeedback: '' };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /overallFeedback/i
    );
  });

  it('throws when "overallFeedback" is whitespace-only', () => {
    const ev = { ...validEvaluation, overallFeedback: '   ' };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /overallFeedback/i
    );
  });

  // ── criteria array ──────────────────────────────────────────────────────────

  it('throws when criteria is not an array', () => {
    const ev = { ...validEvaluation, criteria: 'not-an-array' };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /criteria.*array/i
    );
  });

  it('throws when a criterion id is unknown', () => {
    const ev = {
      ...validEvaluation,
      criteria: [
        { id: 'nonexistent_id', name: 'X', weight: 1, score: 5, justification: 'OK' },
      ],
    };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /nonexistent_id/
    );
  });

  // ── Score validation ────────────────────────────────────────────────────────

  it('throws when score is below 0', () => {
    const ev = {
      ...validEvaluation,
      criteria: validEvaluation.criteria.map((c, i) =>
        i === 0 ? { ...c, score: -1 } : c
      ),
    };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /invalid score/i
    );
  });

  it('throws when score exceeds 10', () => {
    const ev = {
      ...validEvaluation,
      criteria: validEvaluation.criteria.map((c, i) =>
        i === 0 ? { ...c, score: 11 } : c
      ),
    };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /invalid score/i
    );
  });

  it('throws when score is not a number', () => {
    const ev = {
      ...validEvaluation,
      criteria: validEvaluation.criteria.map((c, i) =>
        i === 0 ? { ...c, score: '8' } : c
      ),
    };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /invalid score/i
    );
  });

  // ── Justification ───────────────────────────────────────────────────────────

  it('throws when justification is missing', () => {
    const ev = {
      ...validEvaluation,
      criteria: validEvaluation.criteria.map((c, i) => {
        if (i !== 0) return c;
        const { justification: _, ...rest } = c;
        return rest;
      }),
    };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /justification/i
    );
  });

  it('throws when justification is not a string', () => {
    const ev = {
      ...validEvaluation,
      criteria: validEvaluation.criteria.map((c, i) =>
        i === 0 ? { ...c, justification: 42 } : c
      ),
    };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /justification/i
    );
  });

  // ── weightedScore and grade are recomputed ──────────────────────────────────

  it('recomputes weightedScore from criterion scores regardless of Claude value', () => {
    const ev = { ...validEvaluation, weightedScore: 99 };  // wrong Claude value
    const result = validateEvaluation(toRaw(ev), mockRubric);
    // 8 * 0.6 + 7 * 0.4 = 4.8 + 2.8 = 7.6
    assert.equal(result.weightedScore, 7.6);
  });

  it('derives grade from the computed score and rubric scale', () => {
    const ev = { ...validEvaluation, grade: 'Wrong Grade' };  // wrong Claude value
    const result = validateEvaluation(toRaw(ev), mockRubric);
    assert.equal(result.grade, 'Notable (B)');
  });

  it('throws when a rubric criterion is absent from the evaluation', () => {
    const ev = { ...validEvaluation, criteria: [validEvaluation.criteria[0]] };  // only 1 of 2
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /Missing criterion.*oral_expression/i
    );
  });
});

// ── validateRubric ────────────────────────────────────────────────────────────

describe('validateRubric', () => {

  it('returns the rubric object when input is valid', () => {
    const result = validateRubric(mockRubric);
    assert.equal(result, mockRubric);
  });

  it('throws when rubric is not an object', () => {
    assert.throws(() => validateRubric(null),        /must be a JSON object/i);
    assert.throws(() => validateRubric('string'),    /must be a JSON object/i);
    assert.throws(() => validateRubric([]),          /must be a JSON object/i);
  });

  it('throws when title is missing or empty', () => {
    assert.throws(() => validateRubric({ ...mockRubric, title: '' }),     /title/i);
    assert.throws(() => validateRubric({ ...mockRubric, title: 42 }),     /title/i);
    const { title: _, ...noTitle } = mockRubric;
    assert.throws(() => validateRubric(noTitle),                           /title/i);
  });

  it('throws when criteria is missing or empty', () => {
    assert.throws(() => validateRubric({ ...mockRubric, criteria: [] }),  /non-empty array/i);
    assert.throws(() => validateRubric({ ...mockRubric, criteria: null }), /non-empty array/i);
  });

  it('throws when "language" is present but not a non-empty string', () => {
    assert.throws(() => validateRubric({ ...mockRubric, language: 42 }),   /language/i);
    assert.throws(() => validateRubric({ ...mockRubric, language: '' }),   /language/i);
    assert.doesNotThrow(() => validateRubric({ ...mockRubric, language: 'es' }));
  });

  it('throws when "feedbackLanguage" is present but not a non-empty string', () => {
    assert.throws(() => validateRubric({ ...mockRubric, feedbackLanguage: null }),  /feedbackLanguage/i);
    assert.throws(() => validateRubric({ ...mockRubric, feedbackLanguage: '   ' }), /feedbackLanguage/i);
    assert.doesNotThrow(() => validateRubric({ ...mockRubric, feedbackLanguage: 'en' }));
  });

  it('accepts rubrics without language / feedbackLanguage fields', () => {
    const { language: _l, feedbackLanguage: _f, ...minimalRubric } = mockRubric;
    assert.doesNotThrow(() => validateRubric(minimalRubric));
  });

  it('throws when a criterion is missing its id', () => {
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], id: '' }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /missing.*id/i);
  });

  it('throws when a criterion is missing its name', () => {
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], name: '' }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /"name"/i);
  });

  it('throws when a criterion has a non-string name', () => {
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], name: 42 }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /"name"/i);
  });

  it('throws when a criterion is missing its nameEn', () => {
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], nameEn: '' }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /"nameEn"/i);
  });

  it('throws when a criterion has a non-string nameEn', () => {
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], nameEn: null }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /"nameEn"/i);
  });

  it('throws when a criterion weight is 0 or greater than 1', () => {
    const zeroWeight = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], weight: 0 }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(zeroWeight), /weight/i);

    const tooBig = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], weight: 1.5 }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(tooBig), /weight/i);
  });

  it('throws when weights do not sum to 1', () => {
    const bad = {
      ...mockRubric,
      criteria: mockRubric.criteria.map(c => ({ ...c, weight: 0.3 })),  // 0.3 + 0.3 = 0.6
    };
    assert.throws(() => validateRubric(bad), /weights sum/i);
  });

  it('throws when a criterion is missing levels', () => {
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], levels: [] }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /levels/i);
  });

  it('throws when a level entry has an invalid score', () => {
    const badLevels = [{ score: 11, label: 'X', description: 'Y' }];
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], levels: badLevels }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /levels\[0\].*score/i);
  });

  it('throws when a level entry is missing a label', () => {
    const badLevels = [{ score: 5, label: '', description: 'Y' }];
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], levels: badLevels }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /label/i);
  });

  it('throws when duplicate criterion ids exist', () => {
    const bad = { ...mockRubric, criteria: [mockRubric.criteria[0], mockRubric.criteria[0]] };
    assert.throws(() => validateRubric(bad), /duplicate criterion id/i);
  });

  it('throws when gradingScale is missing or empty', () => {
    assert.throws(() => validateRubric({ ...mockRubric, gradingScale: [] }),  /gradingScale/i);
    assert.throws(() => validateRubric({ ...mockRubric, gradingScale: null }), /gradingScale/i);
  });

  it('throws when a gradingScale entry is missing min or max', () => {
    const bad = { ...mockRubric, gradingScale: [{ label: 'A' }] };
    assert.throws(() => validateRubric(bad), /min.*max.*numbers/i);
  });

  it('throws when a gradingScale entry has max < min', () => {
    const bad = { ...mockRubric, gradingScale: [{ min: 7, max: 5, label: 'X' }] };
    assert.throws(() => validateRubric(bad), /must be >=/i);
  });

  it('throws when a gradingScale entry has a missing label', () => {
    const bad = { ...mockRubric, gradingScale: [{ min: 0, max: 10, label: '' }] };
    assert.throws(() => validateRubric(bad), /label/i);
  });

  // ── gradingScale coverage ───────────────────────────────────────────────────

  it('throws when gradingScale does not cover 0.0', () => {
    const bad = { ...mockRubric, gradingScale: [{ min: 1.0, max: 10.0, label: 'Pass' }] };
    assert.throws(() => validateRubric(bad), /cover 0\.0/i);
  });

  it('throws when gradingScale does not cover 10.0', () => {
    const bad = { ...mockRubric, gradingScale: [{ min: 0.0, max: 9.0, label: 'Fail' }] };
    assert.throws(() => validateRubric(bad), /cover 10\.0/i);
  });

  it('accepts a gradingScale that exactly covers 0.0 to 10.0', () => {
    const good = { ...mockRubric, gradingScale: [{ min: 0, max: 10, label: 'Any' }] };
    assert.doesNotThrow(() => validateRubric(good));
  });

});
