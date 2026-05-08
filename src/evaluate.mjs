import { validateEvaluation } from './validate.mjs';
import { withRetry } from './retry.mjs';

// Structural labels used in the rubric block and correction retry message,
// keyed by BCP-47 language code. Falls back to English for unknown codes.
const PROMPT_I18N = {
  ca: {
    rubric:        'Rúbrica',
    gradingScale:  'Escala de qualificació',
    scoringLevels: 'Nivells de puntuació',
    weight:        'pes',
    maxPts:        'màx 10 pts',
    evaluate:      'Avalua la transcripció contra cada criteri de la rúbrica.',
    perCriterion:  'Per cada criteri proporciona:',
    thenCompute:   'Després calcula:',
    returnJson:    'Retorna exactament aquest format JSON:',
    fixJson:       (msg) => `El JSON retornat no és vàlid: ${msg}\nSi us plau, retorna el JSON corregit seguint exactament l'esquema indicat. Sense text addicional, sense blocs markdown.`,
    transcript:    'Transcripció',
    systemPrompt:  (lang) => `Ets un avaluador acadèmic expert de la Universitat Oberta de Catalunya (UOC).\nAvalues presentacions de vídeo d'estudiants amb la rúbrica proporcionada.\nIMPORTANT: All justifications and the overallFeedback field MUST be written in the language with BCP-47 code "${lang}".\nRetorna ÚNICAMENT un objecte JSON vàlid — sense blocs markdown, sense text addicional.`,
  },
  es: {
    rubric:        'Rúbrica',
    gradingScale:  'Escala de calificación',
    scoringLevels: 'Niveles de puntuación',
    weight:        'peso',
    maxPts:        'máx 10 pts',
    evaluate:      'Evalúa la transcripción contra cada criterio de la rúbrica.',
    perCriterion:  'Por cada criterio proporciona:',
    thenCompute:   'Después calcula:',
    returnJson:    'Devuelve exactamente este formato JSON:',
    fixJson:       (msg) => `El JSON devuelto no es válido: ${msg}\nPor favor, devuelve el JSON corregido siguiendo exactamente el esquema indicado. Sin texto adicional, sin bloques markdown.`,
    transcript:    'Transcripción',
    systemPrompt:  (lang) => `Eres un evaluador académico experto de la Universitat Oberta de Catalunya (UOC).\nEvalúas presentaciones de vídeo de estudiantes con la rúbrica proporcionada.\nIMPORTANT: All justifications and the overallFeedback field MUST be written in the language with BCP-47 code "${lang}".\nDevuelve ÚNICAMENTE un objeto JSON válido — sin bloques markdown, sin texto adicional.`,
  },
  en: {
    rubric:        'Rubric',
    gradingScale:  'Grading scale',
    scoringLevels: 'Scoring levels',
    weight:        'weight',
    maxPts:        'max 10 pts',
    evaluate:      'Evaluate the transcript against each rubric criterion.',
    perCriterion:  'For each criterion provide:',
    thenCompute:   'Then compute:',
    returnJson:    'Return exactly this JSON format:',
    fixJson:       (msg) => `The returned JSON is invalid: ${msg}\nPlease return the corrected JSON following the schema exactly. No extra text, no markdown blocks.`,
    transcript:    'Transcript',
    systemPrompt:  (lang) => `You are an expert academic evaluator at the Universitat Oberta de Catalunya (UOC).\nYou evaluate student video presentations against the provided rubric.\nIMPORTANT: All justifications and the overallFeedback field MUST be written in the language with BCP-47 code "${lang}".\nReturn ONLY a valid JSON object — no markdown blocks, no additional text.`,
  },
};

function t(lang) { return PROMPT_I18N[lang] ?? PROMPT_I18N.en; }

function buildSystemPrompt(lang) {
  return t(lang).systemPrompt(lang);
}

/**
 * Build the static rubric block (criteria + scale + instructions + schema).
 * Identical across all students in a batch run — eligible for prompt caching.
 */
function buildRubricBlock(rubric, lang) {
  const labels = t(lang);

  const criteriaBlock = rubric.criteria.map(c =>
    `### ${c.id} — ${c.nameEn} (${labels.weight}: ${c.weight}, ${labels.maxPts})\n` +
    `${c.description}\n` +
    `${labels.scoringLevels}:\n` +
    c.levels.map(l => `  - ${l.score}/10 (${l.label}): ${l.description}`).join('\n')
  ).join('\n\n');

  return `# ${labels.rubric}: ${rubric.title}

${criteriaBlock}

---

# ${labels.gradingScale}
${rubric.gradingScale.map(g => `${g.min}–${g.max}: ${g.label}`).join('\n')}

---

${labels.evaluate}
${labels.perCriterion}
- score: number 0–10
- justification: 2–4 sentences in "${lang}" with specific evidence from the transcript

${labels.thenCompute}
- weightedScore: sum of (score × weight) for all criteria, rounded to 2 decimals
- grade: corresponding label from the grading scale

${labels.returnJson}
{
  "rubricTitle": "<string>",
  "evaluatedAt": "<ISO 8601>",
  "language": "${lang}",
  "criteria": [
    {
      "id": "<criterion id>",
      "name": "<English criterion name>",
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
  const lang   = rubric.language || rubric.feedbackLanguage || 'ca';
  const label  = t(lang).transcript;
  return `# ${label} (lang: ${lang})\n${transcript.text}`;
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
    max_tokens: thinking ? 16000 : 4096,
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

  try {
    const result = validateEvaluation(rawFirst, rubric);
    onUsage?.(first.usage);  // called exactly once on the happy path
    return result;
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
            content: t(lang).fixJson(firstError.message),
          },
        ],
      }).finalMessage(),
      { onRetry: retryLog }
    );

    const retryText = retry.content.find(b => b.type === 'text');
    if (!retryText) throw new Error('Claude returned no text content in schema-correction retry');
    const rawRetry = retryText.text.trim();

    // Report combined token usage (first attempt + correction retry) exactly once.
    if (onUsage) {
      const f = first.usage ?? {};
      const r = retry.usage ?? {};
      onUsage({
        input_tokens:                (f.input_tokens                ?? 0) + (r.input_tokens                ?? 0),
        output_tokens:               (f.output_tokens               ?? 0) + (r.output_tokens               ?? 0),
        cache_read_input_tokens:     (f.cache_read_input_tokens     ?? 0) + (r.cache_read_input_tokens     ?? 0),
        cache_creation_input_tokens: (f.cache_creation_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0),
      });
    }

    return validateEvaluation(rawRetry, rubric);
  }
}
