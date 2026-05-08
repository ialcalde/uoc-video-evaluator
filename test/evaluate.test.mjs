import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.mjs';
import { mockRubric, validEvaluation } from './fixtures.mjs';

// Build a minimal mock Anthropic client.
// Both the first call and the correction retry go through stream().finalMessage().
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

  it('uses feedbackLanguage from rubric in system prompt and instructions', async () => {
    let capturedSystem, capturedContent;
    const enRubric = { ...mockRubric, feedbackLanguage: 'en' };
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedSystem  = params.system;
            capturedContent = params.messages[0].content;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, enRubric, client);

    const systemText  = capturedSystem[0].text;
    const rubricText  = capturedContent[0].text;
    assert.ok(systemText.includes('"en"'),       'system prompt should embed feedbackLanguage code');
    assert.ok(rubricText.includes('"en"'),       'rubric block should embed feedbackLanguage code');
    assert.ok(!systemText.includes('CATALÀ'),    'should not contain hardcoded CATALÀ when lang=en');
    assert.ok(rubricText.includes('Rubric:'),    'rubric block should use English "Rubric:" label');
    assert.ok(rubricText.includes('Grading scale'), 'rubric block should use English scale label');
  });

  it('uses Spanish structural labels when feedbackLanguage is "es"', async () => {
    let capturedSystem, capturedContent;
    const esRubric = { ...mockRubric, feedbackLanguage: 'es' };
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedSystem  = params.system;
            capturedContent = params.messages[0].content;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, esRubric, client);

    const rubricText = capturedContent[0].text;
    assert.ok(rubricText.includes('Rúbrica:'),           'should use Spanish "Rúbrica:" label');
    assert.ok(rubricText.includes('calificaci'),         'should use Spanish grading scale label');
    assert.ok(rubricText.includes('Evalúa'),             'should use Spanish evaluation instruction');
  });

  it('transcript block uses rubric.language for its label, rubric block uses feedbackLanguage', async () => {
    let capturedContent;
    // language='ca' → transcript label should be "Transcripció"
    // feedbackLanguage='en' → rubric block should use English labels
    const mixedRubric = { ...mockRubric, language: 'ca', feedbackLanguage: 'en' };
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedContent = params.messages[0].content;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, mixedRubric, client);

    const rubricText     = capturedContent[0].text;
    const transcriptText = capturedContent[capturedContent.length - 1].text;

    assert.ok(rubricText.includes('Rubric:'),          'rubric block should use English label (feedbackLanguage=en)');
    assert.ok(transcriptText.includes('Transcripci'),  'transcript label should be Catalan (language=ca)');
    assert.ok(transcriptText.includes('(lang: ca)'),   'transcript block should embed the transcript language code');
  });

  it('includes thinking:{type:"adaptive"} in call params when thinking=true', async () => {
    let capturedThinking;
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedThinking = params.thinking;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, mockRubric, client, { thinking: true });
    assert.deepEqual(capturedThinking, { type: 'adaptive' });
  });

  it('omits thinking param when thinking=false', async () => {
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

    await evaluate(mockTranscript, mockRubric, client, { thinking: false });
    assert.ok(!capturedParams.thinking, 'thinking key should be absent when thinking=false');
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

  it('calls onUsage callback with the usage object from the API response', async () => {
    const fakeUsage = { input_tokens: 1234, output_tokens: 456,
                        cache_read_input_tokens: 800, cache_creation_input_tokens: 0 };
    const client = {
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

    let receivedUsage;
    await evaluate(mockTranscript, mockRubric, client, { onUsage: u => { receivedUsage = u; } });
    assert.deepEqual(receivedUsage, fakeUsage);
  });

  it('accepts onRetry option without error (omitting it falls back to console.warn)', async () => {
    const client = makeClient(JSON.stringify(validEvaluation));
    await assert.doesNotReject(
      () => evaluate(mockTranscript, mockRubric, client, { onRetry: () => {} })
    );
  });

  it('uses console.warn fallback when onRetry is absent and HTTP retry fires', async () => {
    let calls = 0;
    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            calls++;
            if (calls === 1) { const e = new Error('rate limited'); e.status = 429; throw e; }
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };
    // omit onRetry → the console.warn fallback function is used; baseDelay:0 keeps the test instant
    const result = await evaluate(mockTranscript, mockRubric, client, { baseDelay: 0 });
    assert.equal(result.weightedScore, validEvaluation.weightedScore);
  });

  it('handles absent usage on retry attempt — reports only first-attempt usage', async () => {
    const firstUsage = { input_tokens: 800, output_tokens: 200,
                         cache_read_input_tokens: 400, cache_creation_input_tokens: 0 };
    let call = 0;
    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            call++;
            if (call === 1) {
              const broken = { ...validEvaluation };
              delete broken.overallFeedback;
              return { content: [{ type: 'text', text: JSON.stringify(broken) }], usage: firstUsage };
            }
            // Retry returns no usage field
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    let receivedUsage;
    await evaluate(mockTranscript, mockRubric, client, { onUsage: u => { receivedUsage = u; } });

    assert.equal(receivedUsage.input_tokens, 800, 'should use firstUsage (retry has no usage)');
    assert.equal(receivedUsage.output_tokens, 200);
  });

  it('throws when first API response contains no text block', async () => {
    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [{ type: 'thinking', thinking: 'Only thinking, no text block' }],
          }),
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };
    await assert.rejects(
      () => evaluate(mockTranscript, mockRubric, client),
      /no text content.*first attempt/i
    );
  });

  it('throws when schema-correction retry response contains no text block', async () => {
    let call = 0;
    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            call++;
            if (call === 1) {
              // First attempt: invalid JSON triggers the correction retry path
              return { content: [{ type: 'text', text: 'invalid json {' }] };
            }
            // Correction retry: only a thinking block, no text
            return { content: [{ type: 'thinking', thinking: 'Thinking only, no text' }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };
    await assert.rejects(
      () => evaluate(mockTranscript, mockRubric, client),
      /no text content.*retry/i
    );
  });

  it('does not require onUsage (omitting it is safe)', async () => {
    const client = makeClient(JSON.stringify(validEvaluation));
    await assert.doesNotReject(() => evaluate(mockTranscript, mockRubric, client));
  });

  it('handles absent usage on first attempt — reports only retry usage', async () => {
    // first.usage is undefined (API didn't return usage field);
    // retry.usage is defined — combined total should equal retryUsage alone.
    const retryUsage = { input_tokens: 600, output_tokens: 120,
                         cache_read_input_tokens: 0, cache_creation_input_tokens: 50 };
    let call = 0;
    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            call++;
            if (call === 1) {
              const broken = { ...validEvaluation };
              delete broken.overallFeedback;
              return { content: [{ type: 'text', text: JSON.stringify(broken) }] }; // no usage
            }
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }], usage: retryUsage };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    let receivedUsage;
    await evaluate(mockTranscript, mockRubric, client, { onUsage: u => { receivedUsage = u; } });

    assert.equal(receivedUsage.input_tokens,              600, 'should fall back to 0 for missing first.usage');
    assert.equal(receivedUsage.cache_creation_input_tokens, 50);
  });

  it('falls back to English structural labels for an unknown feedbackLanguage code', async () => {
    let capturedContent;
    const frRubric = { ...mockRubric, feedbackLanguage: 'fr' };
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedContent = params.messages[0].content;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, frRubric, client);

    const rubricText = capturedContent[0].text;
    assert.ok(rubricText.includes('Rubric:'), 'unknown language should fall back to English "Rubric:" label');
    assert.ok(rubricText.includes('Grading scale'), 'unknown language should fall back to English grading scale label');
  });

  it('uses feedbackLanguage as transcript lang when rubric.language is absent', async () => {
    let capturedContent;
    const rubricNoLang = { ...mockRubric, feedbackLanguage: 'en' };
    delete rubricNoLang.language;
    const client = {
      messages: {
        stream: (params) => ({
          finalMessage: async () => {
            capturedContent = params.messages[0].content;
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    await evaluate(mockTranscript, rubricNoLang, client);

    const transcriptText = capturedContent[capturedContent.length - 1].text;
    assert.ok(transcriptText.includes('(lang: en)'), 'transcript block should use feedbackLanguage when language is absent');
  });

  it('combines first-attempt and correction-retry token usage in onUsage', async () => {
    const firstUsage = { input_tokens: 1000, output_tokens: 200,
                         cache_read_input_tokens: 400, cache_creation_input_tokens: 0 };
    const retryUsage = { input_tokens: 500,  output_tokens: 150,
                         cache_read_input_tokens: 200, cache_creation_input_tokens: 0 };

    let call = 0;
    const client = {
      messages: {
        stream: () => ({
          finalMessage: async () => {
            call++;
            if (call === 1) {
              // First attempt: valid JSON but missing overallFeedback to trigger correction
              const broken = { ...validEvaluation };
              delete broken.overallFeedback;
              return { content: [{ type: 'text', text: JSON.stringify(broken) }], usage: firstUsage };
            }
            // Correction retry: valid JSON
            return { content: [{ type: 'text', text: JSON.stringify(validEvaluation) }], usage: retryUsage };
          },
        }),
        create: async () => ({ content: [{ type: 'text', text: JSON.stringify(validEvaluation) }] }),
      },
    };

    let receivedUsage;
    await evaluate(mockTranscript, mockRubric, client, { onUsage: u => { receivedUsage = u; } });

    assert.equal(receivedUsage.input_tokens,              1500, 'input should be summed');
    assert.equal(receivedUsage.output_tokens,              350, 'output should be summed');
    assert.equal(receivedUsage.cache_read_input_tokens,    600, 'cache-hit should be summed');
  });
});
