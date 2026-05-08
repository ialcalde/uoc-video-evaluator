/**
 * Parse and validate the raw JSON string returned by Claude.
 *
 * Checks:
 *  - Valid JSON
 *  - Required top-level fields present
 *  - criteria array matches rubric IDs
 *  - Each score is a number in [0, 10]
 *  - weightedScore is a number
 *
 * @param {string} raw     Raw text from Claude's response.
 * @param {object} rubric  Parsed rubric.json object.
 * @returns {object}       Validated evaluation object.
 * @throws {Error}         With a descriptive message on any violation.
 */
export function validateEvaluation(raw, rubric) {
  // 1. Strip markdown code fences that Claude occasionally wraps around JSON
  let cleaned = String(raw).trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/, '$1').trim();
  }

  // 2. Parse
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `JSON malformat: ${e.message}\n` +
      `Start of response: ${cleaned.slice(0, 300)}`
    );
  }

  // 3. Required top-level fields
  if (parsed.criteria === undefined) {
    throw new Error('Missing required field: "criteria"');
  }
  if (typeof parsed.overallFeedback !== 'string' || !parsed.overallFeedback.trim()) {
    throw new Error('"overallFeedback" must be a non-empty string');
  }

  // 3. criteria must be an array
  if (!Array.isArray(parsed.criteria)) {
    throw new Error('"criteria" must be an array');
  }

  // 4. Each rubric criterion must be present with a valid score and justification
  const rubricIds = new Set(rubric.criteria.map(c => c.id));
  const parsedIds = new Set(parsed.criteria.map(c => c.id));

  // Unknown IDs first (catches Claude hallucinating criterion names)
  for (const c of parsed.criteria) {
    if (!c.id || !rubricIds.has(c.id)) {
      throw new Error(`Unknown or missing criterion id: "${c.id}"`);
    }
    if (typeof c.score !== 'number' || c.score < 0 || c.score > 10) {
      throw new Error(
        `Criterion "${c.id}" has invalid score: ${JSON.stringify(c.score)} (must be number 0–10)`
      );
    }
    if (!c.justification || typeof c.justification !== 'string') {
      throw new Error(`Criterion "${c.id}" is missing or has a non-string justification`);
    }
  }

  // Missing IDs second (catches Claude omitting a criterion entirely)
  for (const { id } of rubric.criteria) {
    if (!parsedIds.has(id)) {
      throw new Error(`Missing criterion in evaluation: "${id}"`);
    }
  }

  // 5. Recompute weightedScore and grade from verified criterion scores
  const weightMap      = Object.fromEntries(rubric.criteria.map(c => [c.id, c.weight]));
  const computed       = parsed.criteria.reduce((s, c) => s + c.score * weightMap[c.id], 0);
  parsed.weightedScore = Math.round(computed * 100) / 100;

  const scaleEntry = rubric.gradingScale.find(
    g => parsed.weightedScore >= g.min && parsed.weightedScore <= g.max
  );
  parsed.grade = scaleEntry
    ? scaleEntry.label
    : rubric.gradingScale[rubric.gradingScale.length - 1].label;

  return parsed;
}

/**
 * Validate the structure of a parsed rubric.json object.
 * Called at startup so professors get clear errors before any API calls.
 *
 * @param {object} rubric  Parsed rubric object.
 * @returns {object}       The same object if valid.
 * @throws {Error}         With a descriptive message on any violation.
 */
export function validateRubric(rubric) {
  if (!rubric || typeof rubric !== 'object' || Array.isArray(rubric)) {
    throw new Error('Rubric must be a JSON object');
  }

  if (typeof rubric.title !== 'string' || !rubric.title.trim()) {
    throw new Error('Rubric missing required string field: "title"');
  }

  for (const field of ['language', 'feedbackLanguage']) {
    if (rubric[field] !== undefined) {
      if (typeof rubric[field] !== 'string' || !rubric[field].trim()) {
        throw new Error(`"${field}" must be a non-empty BCP-47 string (e.g. "ca", "es", "en") when present`);
      }
    }
  }

  if (!Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
    throw new Error('Rubric "criteria" must be a non-empty array');
  }

  let totalWeight = 0;
  for (const [i, c] of rubric.criteria.entries()) {
    const ctx = `criteria[${i}]`;

    if (!c.id || typeof c.id !== 'string') {
      throw new Error(`${ctx}: missing or non-string "id"`);
    }
    if (typeof c.name !== 'string' || !c.name.trim()) {
      throw new Error(`${ctx} ("${c.id}"): "name" must be a non-empty string`);
    }
    if (typeof c.nameEn !== 'string' || !c.nameEn.trim()) {
      throw new Error(`${ctx} ("${c.id}"): "nameEn" must be a non-empty string`);
    }
    if (typeof c.weight !== 'number' || c.weight <= 0 || c.weight > 1) {
      throw new Error(`${ctx} ("${c.id}"): "weight" must be a number in (0, 1], got ${JSON.stringify(c.weight)}`);
    }
    if (typeof c.description !== 'string') {
      throw new Error(`${ctx} ("${c.id}"): missing or non-string "description"`);
    }
    if (!Array.isArray(c.levels) || c.levels.length === 0) {
      throw new Error(`${ctx} ("${c.id}"): "levels" must be a non-empty array`);
    }
    for (const [li, level] of c.levels.entries()) {
      if (typeof level.score !== 'number' || level.score < 0 || level.score > 10) {
        throw new Error(`${ctx} ("${c.id}") levels[${li}]: "score" must be a number 0–10`);
      }
      if (typeof level.label !== 'string' || !level.label.trim()) {
        throw new Error(`${ctx} ("${c.id}") levels[${li}]: "label" must be a non-empty string`);
      }
      if (typeof level.description !== 'string') {
        throw new Error(`${ctx} ("${c.id}") levels[${li}]: "description" must be a string`);
      }
    }

    totalWeight += c.weight;
  }

  // Duplicate criterion IDs
  const idSet = new Set();
  for (const c of rubric.criteria) {
    if (idSet.has(c.id)) throw new Error(`Duplicate criterion id: "${c.id}"`);
    idSet.add(c.id);
  }

  if (Math.abs(totalWeight - 1) > 0.01) {
    throw new Error(
      `Criteria weights sum to ${totalWeight.toFixed(3)}, expected 1.000 (±0.01)`
    );
  }

  if (!Array.isArray(rubric.gradingScale) || rubric.gradingScale.length === 0) {
    throw new Error('Rubric "gradingScale" must be a non-empty array');
  }

  for (const [i, entry] of rubric.gradingScale.entries()) {
    const ctx = `gradingScale[${i}]`;
    if (typeof entry.min !== 'number' || typeof entry.max !== 'number') {
      throw new Error(`${ctx}: "min" and "max" must be numbers`);
    }
    if (entry.max < entry.min) {
      throw new Error(`${ctx}: "max" (${entry.max}) must be >= "min" (${entry.min})`);
    }
    if (typeof entry.label !== 'string' || !entry.label.trim()) {
      throw new Error(`${ctx}: "label" must be a non-empty string`);
    }
  }

  // Grading scale must cover [0, 10] so every possible weighted score has a grade
  const lowestMin  = Math.min(...rubric.gradingScale.map(g => g.min));
  const highestMax = Math.max(...rubric.gradingScale.map(g => g.max));
  if (lowestMin > 0.01) {
    throw new Error(
      `gradingScale must cover 0.0 — lowest "min" is ${lowestMin}. ` +
      'Add an entry that starts at 0.'
    );
  }
  if (highestMax < 9.99) {
    throw new Error(
      `gradingScale must cover 10.0 — highest "max" is ${highestMax}. ` +
      'Add an entry that ends at 10.'
    );
  }

  return rubric;
}
