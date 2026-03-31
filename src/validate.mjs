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
  // 1. Parse
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `JSON malformat: ${e.message}\n` +
      `Start of response: ${String(raw).slice(0, 300)}`
    );
  }

  // 2. Required top-level fields
  for (const field of ['criteria', 'weightedScore', 'grade', 'overallFeedback']) {
    if (parsed[field] === undefined) {
      throw new Error(`Missing required field: "${field}"`);
    }
  }

  // 3. criteria must be an array
  if (!Array.isArray(parsed.criteria)) {
    throw new Error('"criteria" must be an array');
  }

  // 4. Each criterion must match rubric and have a valid score
  const rubricIds = new Set(rubric.criteria.map(c => c.id));
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

  // 5. weightedScore must be a number
  if (typeof parsed.weightedScore !== 'number') {
    throw new Error(
      `"weightedScore" must be a number, got: ${typeof parsed.weightedScore}`
    );
  }

  return parsed;
}
