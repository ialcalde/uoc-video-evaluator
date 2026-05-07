import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { mockRubric, validEvaluation } from './fixtures.mjs';

// Build a minimal mock Anthropic client whose create() returns a given text.
function makeClient(...responses) {
  let call = 0;
  return {
    messages: {
      create: async () => {
        const text = responses[Math.min(call++, responses.length - 1)];
        return { content: [{ text }] };
      },
    },
  };
}

const mockTranscript = { text: 'Hola, sóc un estudiant de la UOC.' };

describe('evaluate', () => {

  it('returns validated evaluation when Claude responds with valid JSON on first attempt', async () => {
    const client = makeClient(JSON.stringify(validEvaluation));
    const result = await evaluate(mockTranscript, mockRubric, client);

    assert.equal(result.weightedScore, validEvaluation.weightedScore);
    assert.equal(result.grade, validEvaluation.grade);
    assert.equal(result.criteria.length, 2);
  });

  it('retries once on invalid JSON and returns the corrected evaluation', async () => {
    // First response: invalid JSON → triggers retry
    // Second response: valid JSON
    const client = makeClient('not valid json }{', JSON.stringify(validEvaluation));
    const result = await evaluate(mockTranscript, mockRubric, client);

    assert.equal(result.weightedScore, validEvaluation.weightedScore);
  });

  it('throws when both attempts produce invalid JSON', async () => {
    const client = makeClient('bad1', 'bad2');
    await assert.rejects(
      () => evaluate(mockTranscript, mockRubric, client),
      /JSON malformat/i
    );
  });

  it('throws when first attempt has valid JSON but fails schema validation, and retry also fails', async () => {
    // First: valid JSON but missing required field
    const broken = { ...validEvaluation };
    delete broken.overallFeedback;

    // Second: another broken response
    const client = makeClient(JSON.stringify(broken), JSON.stringify(broken));

    await assert.rejects(
      () => evaluate(mockTranscript, mockRubric, client),
      /overallFeedback/i
    );
  });

  it('passes the transcript text and rubric to the API', async () => {
    let capturedMessages;
    const client = {
      messages: {
        create: async ({ messages }) => {
          capturedMessages = messages;
          return { content: [{ text: JSON.stringify(validEvaluation) }] };
        },
      },
    };

    await evaluate(mockTranscript, mockRubric, client);

    const prompt = capturedMessages[0].content;
    assert.ok(prompt.includes(mockTranscript.text), 'transcript should appear in the prompt');
    assert.ok(prompt.includes(mockRubric.title), 'rubric title should appear in the prompt');
  });
});
