import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { mockRubric, validEvaluation } from './fixtures.mjs';

// Build a minimal mock Anthropic client.
// First call goes through stream().finalMessage(); retries go through create().
function makeClient(...responses) {
  let call = 0;
  const next = () => ({ content: [{ type: 'text', text: responses[Math.min(call++, responses.length - 1)] }] });
  return {
    messages: {
      stream:  ()    => ({ finalMessage: async () => next() }),
      create:  async () => next(),
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
        stream: ({ messages }) => ({
          finalMessage: async () => {
            capturedMessages = messages;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, mockRubric, client);

    const content = capturedMessages[0].content;
    assert.ok(Array.isArray(content), 'content should be an array of blocks');
    const fullText = content.map(b => b.text).join(' ');
    assert.ok(fullText.includes(mockTranscript.text), 'transcript should appear in the prompt');
    assert.ok(fullText.includes(mockRubric.title),    'rubric title should appear in the prompt');
  });

  it('handles a thinking block before the text block (extended thinking)', async () => {
    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [
              { type: 'thinking', thinking: 'Let me consider the criteria...' },
              { type: 'text', text: JSON.stringify(validEvaluation) },
            ],
          }),
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    const result = await evaluate(mockTranscript, mockRubric, client);
    assert.equal(result.weightedScore, validEvaluation.weightedScore);
  });

  it('forwards the model option to the API call', async () => {
    let capturedModel;
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedModel = params.model;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, mockRubric, client, { model: 'claude-opus-4-7' });
    assert.equal(capturedModel, 'claude-opus-4-7');
  });

  it('sets cache_control on rubric block and system prompt, not on transcript block', async () => {
    let capturedParams;
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedParams = params;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, mockRubric, client);

    // System must be an array with cache_control on the first (only) block
    const system = capturedParams.system;
    assert.ok(Array.isArray(system), 'system should be an array');
    assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });

    // User content: first block = rubric (cached), last block = transcript (not cached)
    const content = capturedParams.messages[0].content;
    assert.ok(Array.isArray(content), 'user content should be an array');
    assert.deepEqual(content[0].cache_control, { type: 'ephemeral' }, 'rubric block should be cached');
    assert.ok(!content[content.length - 1].cache_control,             'transcript block should not be cached');
  });
});
