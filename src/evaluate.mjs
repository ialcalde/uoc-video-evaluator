import { validateEvaluation } from './validate.mjs';
import { withRetry } from './retry.mjs';

function buildSystemPrompt(lang) {
  return `Ets un avaluador acadèmic expert de la Universitat Oberta de Catalunya (UOC).
Avalues presentacions de vídeo d'estudiants amb la rúbrica proporcionada.
IMPORTANT: All justifications and the overallFeedback field MUST be written in the language with BCP-47 code "${lang}".
Retorna ÚNICAMENT un objecte JSON vàlid — sense blocs markdown, sense text addicional.`;
}

/**
 * Build the static rubric block (criteria + scale + instructions + schema).
 * Identical across all students in a batch run — eligible for prompt caching.
 */
function buildRubricBlock(rubric, lang) {

  const criteriaBlock = rubric.criteria.map(c =>
    `### ${c.id} — ${c.nameEn} (pes: ${c.weight}, màx 10 pts)\n` +
    `${c.description}\n` +
    `Nivells de puntuació:\n` +
    c.levels.map(l => `  - ${l.score}/10 (${l.label}): ${l.description}`).join('\n')
  ).join('\n\n');

  return `# Rúbrica: ${rubric.title}

${criteriaBlock}

---

# Escala de qualificació
${rubric.gradingScale.map(g => `${g.min}–${g.max}: ${g.label}`).join('\n')}

---

Avalua la transcripció contra cada criteri de la rúbrica.
Per cada criteri proporciona:
- score: número 0–10
- justification: 2–4 sentences in "${lang}" with specific evidence from the transcript

Després calcula:
- weightedScore: suma de (score × weight) per a tots els criteris, arrodonit a 2 decimals
- grade: etiqueta corresponent de l'escala de qualificació

Retorna exactament aquest format JSON:
{
  "rubricTitle": "<string>",
  "evaluatedAt": "<ISO 8601>",
  "language": "${lang}",
  "criteria": [
    {
      "id": "<id del criteri>",
      "name": "<nom en anglès>",
      "weight": <number>,
      "score": <number 0-10>,
      "justification": "<text in ${lang}>"
    }
  ],
  "weightedScore": <number>,
  "grade": "<string>",
  "overallFeedback": "<3–5 sentences in ${lang}: one strength and one area for improvement>"
}`;
}

/**
 * Build the per-student transcript block. Changes every call — not cached.
 */
function buildTranscriptBlock(transcript, rubric) {
  const lang = rubric.language || rubric.feedbackLanguage || 'ca';
  return `# Transcripció (idioma: ${lang})\n${transcript.text}`;
}

/**
 * Evaluate a transcript against the rubric using Claude.
 * Retries once if the returned JSON fails validation.
 *
 * The rubric block and system prompt carry cache_control so they are reused
 * across students in the same batch run, saving input tokens.
 *
 * @param {{text: string}} transcript   Whisper transcription object.
 * @param {object}         rubric       Parsed rubric.json.
 * @param {import('@anthropic-ai/sdk').default} anthropic  Initialised Anthropic client.
 * @returns {Promise<object>}           Validated evaluation object.
 */
export async function evaluate(transcript, rubric, anthropic, { model = 'claude-sonnet-4-6', thinking = false, onUsage } = {}) {
  const lang = rubric.feedbackLanguage || 'ca';

  const systemConfig = [
    { type: 'text', text: buildSystemPrompt(lang), cache_control: { type: 'ephemeral' } },
  ];
  const userContent = [
    { type: 'text', text: buildRubricBlock(rubric, lang),     cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildTranscriptBlock(transcript, rubric) },
  ];

  const callParams = {
    model,
    max_tokens: thinking ? 8000 : 2048,
    system:     systemConfig,
    ...(thinking ? { thinking: { type: 'adaptive' } } : {}),
  };

  const retryLog = ({ attempt, maxRetries, status }) =>
    console.warn(`[WARN]  evaluate: HTTP ${status} — retry ${attempt}/${maxRetries}`);

  // ── First attempt — streamed to avoid timeout on long transcripts ───────
  const first = await withRetry(
    () => anthropic.messages.stream({
      ...callParams,
      messages: [{ role: 'user', content: userContent }],
    }).finalMessage(),
    { onRetry: retryLog }
  );

  const firstText = first.content.find(b => b.type === 'text');
  if (!firstText) throw new Error('Claude returned no text content in first attempt');
  const rawFirst = firstText.text.trim();

  onUsage?.(first.usage);

  try {
    return validateEvaluation(rawFirst, rubric);
  } catch (firstError) {
    // ── Schema-correction retry — streamed for the same timeout-safety reason as the
    //    first call; the input (rubric + transcript + first response) can be large.
    const retry = await withRetry(
      () => anthropic.messages.stream({
        ...callParams,
        messages: [
          { role: 'user',      content: userContent },
          { role: 'assistant', content: rawFirst    },
          {
            role: 'user',
            content:
              `El JSON retornat no és vàlid: ${firstError.message}\n` +
              `Si us plau, retorna el JSON corregit seguint exactament l'esquema indicat. ` +
              `Sense text addicional, sense blocs markdown.`,
          },
        ],
      }).finalMessage(),
      { onRetry: retryLog }
    );

    const retryText = retry.content.find(b => b.type === 'text');
    if (!retryText) throw new Error('Claude returned no text content in schema-correction retry');
    const rawRetry = retryText.text.trim();
    return validateEvaluation(rawRetry, rubric);
  }
}
