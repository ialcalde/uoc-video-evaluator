/**
 * Shared fixtures for all test files.
 * Uses a minimal 2-criteria rubric to keep tests concise.
 */

export const mockRubric = {
  title: 'Test Rubric',
  version: '1.0',
  language: 'ca',
  feedbackLanguage: 'ca',
  totalPoints: 10,
  criteria: [
    {
      id: 'content_accuracy',
      name: 'Contingut i precisió',
      nameEn: 'Content & Accuracy',
      weight: 0.6,
      description: 'Accurate content.',
      levels: [
        { score: 10, label: 'Excel·lent', description: 'Perfect.' },
        { score: 5,  label: 'Aprovat',    description: 'Acceptable.' },
        { score: 0,  label: 'Suspès',     description: 'Insufficient.' },
      ],
    },
    {
      id: 'oral_expression',
      name: 'Expressió oral',
      nameEn: 'Oral Expression',
      weight: 0.4,
      description: 'Clear speech.',
      levels: [
        { score: 10, label: 'Excel·lent', description: 'Perfect.' },
        { score: 5,  label: 'Aprovat',    description: 'Acceptable.' },
        { score: 0,  label: 'Suspès',     description: 'Insufficient.' },
      ],
    },
  ],
  gradingScale: [
    { min: 9.0, max: 10.0, label: 'Excel·lent (A)' },
    { min: 7.0, max: 8.9,  label: 'Notable (B)'    },
    { min: 5.0, max: 6.9,  label: 'Aprovat (C)'    },
    { min: 0.0, max: 4.9,  label: 'Suspès (D)'     },
  ],
};

export const validEvaluation = {
  rubricTitle:     'Test Rubric',
  evaluatedAt:     '2026-05-07T12:00:00.000Z',
  language:        'ca',
  criteria: [
    {
      id:            'content_accuracy',
      name:          'Content & Accuracy',
      weight:        0.6,
      score:         8,
      justification: 'El contingut és precís i ben argumentat.',
    },
    {
      id:            'oral_expression',
      name:          'Oral Expression',
      weight:        0.4,
      score:         7,
      justification: "L'expressió oral és clara i entenedora.",
    },
  ],
  weightedScore:   7.6,
  grade:           'Notable (B)',
  overallFeedback: 'Bona presentació en general. Cal millorar el ritme.',
};
