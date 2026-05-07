import { existsSync, mkdirSync, readdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// ── CSV helpers ───────────────────────────────────────────────────────────────

export function csvField(value) {
  const s = String(value ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/**
 * Write results.csv to outputDir.
 *
 * Each row: student, score, grade, status, <one column per criterion>, error
 * Returns the full path of the written file.
 */
export async function writeCsv(outputDir, results, rubric) {
  const criteriaIds = rubric.criteria.map(c => c.id);
  const header = ['student', 'score', 'grade', 'status', ...criteriaIds, 'error'].join(',');

  const rows = results.map(r => {
    if (r.status === 'error') {
      return [
        csvField(r.student), '', '', 'error',
        ...criteriaIds.map(() => ''),
        csvField(r.error),
      ].join(',');
    }

    const scoreMap = Object.fromEntries(
      r.evaluation.criteria.map(c => [c.id, c.score])
    );
    return [
      csvField(r.student),
      r.evaluation.weightedScore,
      csvField(r.evaluation.grade),
      'ok',
      ...criteriaIds.map(id => scoreMap[id] ?? ''),
      '',
    ].join(',');
  });

  const csv     = [header, ...rows].join('\n');
  const csvPath = join(outputDir, 'results.csv');
  await writeFile(csvPath, csv, 'utf8');
  return csvPath;
}

/**
 * Ensure output/<student>/ directory exists and return its path.
 */
export function ensureStudentDir(outputDir, student) {
  const dir = join(outputDir, student);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write transcript_ca.txt
 */
export async function writeTranscript(studentDir, transcriptText) {
  await writeFile(join(studentDir, 'transcript_ca.txt'), transcriptText, 'utf8');
}

/**
 * Write evaluation.json
 */
export async function writeEvaluation(studentDir, evaluation) {
  await writeFile(
    join(studentDir, 'evaluation.json'),
    JSON.stringify(evaluation, null, 2),
    'utf8'
  );
}

/**
 * Write feedback_ca.txt — human-readable summary in Catalan.
 */
/**
 * Scan outputDir for student sub-directories with evaluation.json and rebuild results.csv.
 * Useful after a partial batch run or when adding new evaluations.
 *
 * @param {string} outputDir  Directory containing per-student sub-folders.
 * @param {object} rubric     Parsed rubric (needed for CSV column names).
 * @returns {Promise<string>} Path of the written CSV.
 */
export async function rebuildCsv(outputDir, rubric) {
  const entries = readdirSync(outputDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const evalPath = join(outputDir, entry.name, 'evaluation.json');
    if (!existsSync(evalPath)) continue;
    try {
      const evaluation = JSON.parse(await readFile(evalPath, 'utf8'));
      results.push({ student: entry.name, status: 'ok', evaluation });
    } catch { /* skip unreadable files */ }
  }

  results.sort((a, b) => a.student.localeCompare(b.student));
  return writeCsv(outputDir, results, rubric);
}

export async function writeFeedback(studentDir, evaluation) {
  const lines = [
    `Data d'avaluació : ${evaluation.evaluatedAt}`,
    `Nota             : ${evaluation.weightedScore} / 10`,
    `Qualificació     : ${evaluation.grade}`,
    '',
    '══════════════════════════════════════════════════════',
    'DETALL PER CRITERI',
    '══════════════════════════════════════════════════════',
    '',
  ];

  for (const c of evaluation.criteria) {
    const filled = Math.round(c.score);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    lines.push(`${c.name} (pes ${c.weight})`);
    lines.push(`  Puntuació : ${c.score}/10  [${bar}]`);
    lines.push(`  ${c.justification}`);
    lines.push('');
  }

  lines.push(
    '══════════════════════════════════════════════════════',
    'VALORACIÓ GLOBAL',
    '══════════════════════════════════════════════════════',
    '',
    evaluation.overallFeedback,
  );

  await writeFile(join(studentDir, 'feedback_ca.txt'), lines.join('\n'), 'utf8');
}
