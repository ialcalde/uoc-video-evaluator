import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvaluation } from '../src/validate.mjs';
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

  for (const field of ['criteria', 'weightedScore', 'grade', 'overallFeedback']) {
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

  // ── weightedScore type ──────────────────────────────────────────────────────

  it('throws when weightedScore is a string', () => {
    const ev = { ...validEvaluation, weightedScore: '7.6' };
    assert.throws(
      () => validateEvaluation(toRaw(ev), mockRubric),
      /weightedScore.*number/i
    );
  });
});
