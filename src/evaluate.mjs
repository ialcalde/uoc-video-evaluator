import { validateEvaluation } from './validate.mjs';

const SYSTEM_PROMPT =
  `Ets un avaluador acadèmic expert de la Universitat Oberta de Catalunya (UOC).
Avalues presentacions de vídeo d'estudiants amb la rúbrica proporcionada.
IMPORTANT: Totes les justificacions i el camp overallFeedback han d'estar escrits en CATALÀ.
Retorna ÚNICAMENT un objecte JSON vàlid — sense blocs markdown, sense text addicional.`;

/**
 * Build the user prompt from transcript + rubric.
 */
function buildPrompt(transcript, rubric) {
  const lang = rubric.feedbackLanguage || 'ca';

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

# Transcripció (idioma: ${lang})
${transcript.text}

---

Avalua la transcripció contra cada criteri de la rúbrica.
Per cada criteri proporciona:
- score: número 0–10
- justification: 2–4 frases en CATALÀ amb evidències específiques de la transcripció

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
      "justification": "<text en CATALÀ>"
    }
  ],
  "weightedScore": <number>,
  "grade": "<string>",
  "overallFeedback": "<resum de 3–5 frases en CATALÀ amb un punt fort i una àrea de millora>"
}`;
}

/**
 * Evaluate a transcript against the rubric using Claude.
 * Retries once if the returned JSON fails validation.
 *
 * @param {{text: string}} transcript   Whisper transcription object.
 * @param {object}         rubric       Parsed rubric.json.
 * @param {import('@anthropic-ai/sdk').default} anthropic  Initialised Anthropic client.
 * @returns {Promise<object>}           Validated evaluation object.
 */
export async function evaluate(transcript, rubric, anthropic) {
  const userPrompt = buildPrompt(transcript, rubric);

  // ── First attempt ────────────────────────────────────────────────────────
  const first = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const rawFirst = first.content[0].text.trim();

  try {
    return validateEvaluation(rawFirst, rubric);
  } catch (firstError) {
    // ── Single retry with correction context ─────────────────────────────
    const retry = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages: [
        { role: 'user',      content: userPrompt },
        { role: 'assistant', content: rawFirst   },
        {
          role: 'user',
          content:
            `El JSON retornat no és vàlid: ${firstError.message}\n` +
            `Si us plau, retorna el JSON corregit seguint exactament l'esquema indicat. ` +
            `Sense text addicional, sense blocs markdown.`,
        },
      ],
    });

    const rawRetry = retry.content[0].text.trim();
    // Let any validation error here propagate — the caller will catch it
    return validateEvaluation(rawRetry, rubric);
  }
}
