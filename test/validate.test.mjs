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

  // ── Missing top-level fields ────────────────────────────────────────────────

  for (const field of ['criteria', 'overallFeedback']) {
    it(`throws when "${field}" is missing`, () => {
      const ev = { ...validEvaluation };
      delete ev[field];
      assert.throws(
        () => validateEvaluation(toRaw(ev), mockRubric),
        new RegExp(field)
      );
    });
  }

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

  it('throws when a criterion is missing its id', () => {
    const bad = { ...mockRubric, criteria: [{ ...mockRubric.criteria[0], id: '' }, mockRubric.criteria[1]] };
    assert.throws(() => validateRubric(bad), /missing.*id/i);
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

});
