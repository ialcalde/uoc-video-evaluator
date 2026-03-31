import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

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
