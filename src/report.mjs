import { existsSync, mkdirSync, readdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';

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
 * Each row: student, score, grade, status, <one column per criterion>, overallFeedback, error
 * Returns the full path of the written file.
 */
export async function writeCsv(outputDir, results, rubric) {
  const criteriaIds = rubric.criteria.map(c => c.id);
  const header = ['student', 'score', 'grade', 'status', 'evaluatedAt', ...criteriaIds, 'overallFeedback', 'error'].join(',');

  const rows = results.map(r => {
    if (r.status === 'error') {
      return [
        csvField(r.student), '', '', 'error', '',
        ...criteriaIds.map(() => ''),
        '',
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
      csvField(r.evaluation.evaluatedAt ?? ''),
      ...criteriaIds.map(id => scoreMap[id] ?? ''),
      csvField(r.evaluation.overallFeedback ?? ''),
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
 * Write transcript_{lang}.txt
 * @param {string} studentDir
 * @param {string} transcriptText
 * @param {string} [lang='ca']  BCP-47 language code used as filename suffix.
 */
export async function writeTranscript(studentDir, transcriptText, lang = 'ca') {
  await writeFile(join(studentDir, `transcript_${lang}.txt`), transcriptText, 'utf8');
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
  const csvPath = await writeCsv(outputDir, results, rubric);
  return { csvPath, count: results.length };
}

const I18N = {
  ca: { student: 'Estudiant', rubric: 'Rúbrica',   evaluatedAt: "Data d'avaluació", score: 'Nota',    grade: 'Qualificació', criteria: 'DETALL PER CRITERI',     overall: 'VALORACIÓ GLOBAL',  weight: 'pes',    scoreLabel: 'Puntuació'  },
  es: { student: 'Estudiante', rubric: 'Rúbrica',  evaluatedAt: 'Fecha de evaluación', score: 'Nota', grade: 'Calificación', criteria: 'DETALLE POR CRITERIO',   overall: 'VALORACIÓN GLOBAL', weight: 'peso',   scoreLabel: 'Puntuación' },
  en: { student: 'Student',    rubric: 'Rubric',   evaluatedAt: 'Evaluation date',   score: 'Score', grade: 'Grade',        criteria: 'CRITERIA DETAIL',         overall: 'OVERALL FEEDBACK',   weight: 'weight', scoreLabel: 'Score'      },
};

/**
 * Write feedback_{lang}.txt — human-readable evaluation summary.
 * Structural labels are localised for 'ca', 'es', and 'en'; other lang codes fall back to 'en'.
 * @param {string} studentDir
 * @param {object} evaluation
 * @param {string} [lang='ca']  BCP-47 language code used for both filename and labels.
 */
export async function writeFeedback(studentDir, evaluation, lang = 'ca') {
  const t       = I18N[lang] ?? I18N.en;
  const student = basename(studentDir);
  const SEP     = '══════════════════════════════════════════════════════';

  const colW = Math.max(
    t.rubric.length, t.student.length, t.evaluatedAt.length, t.score.length, t.grade.length
  ) + 2;

  const lines = [
    `${t.rubric.padEnd(colW)} : ${evaluation.rubricTitle ?? ''}`,
    `${t.student.padEnd(colW)} : ${student}`,
    `${t.evaluatedAt.padEnd(colW)} : ${evaluation.evaluatedAt ?? ''}`,
    `${t.score.padEnd(colW)} : ${evaluation.weightedScore} / 10`,
    `${t.grade.padEnd(colW)} : ${evaluation.grade}`,
    '',
    SEP,
    t.criteria,
    SEP,
    '',
  ];

  for (const c of evaluation.criteria) {
    const filled = Math.round(c.score);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    lines.push(`${c.name} (${t.weight} ${c.weight})`);
    lines.push(`  ${t.scoreLabel} : ${c.score}/10  [${bar}]`);
    lines.push(`  ${c.justification}`);
    lines.push('');
  }

  lines.push(
    SEP,
    t.overall,
    SEP,
    '',
    evaluation.overallFeedback,
  );

  await writeFile(join(studentDir, `feedback_${lang}.txt`), lines.join('\n'), 'utf8');
}
