/**
 * demo.mjs — Generates realistic sample output WITHOUT any API keys or ffmpeg.
 *
 * Uses the real report.mjs / validate.mjs modules with a canned evaluation,
 * so you can inspect exactly what the tool produces before connecting real APIs.
 *
 *   node demo.mjs
 *
 * Output: output/demo_<student>/ directories + output/results.csv
 */

import { mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import { validateEvaluation, validateRubric } from './src/validate.mjs';
import {
  ensureStudentDir, writeTranscript, writeEvaluation,
  writeFeedback, writeCsv,
} from './src/report.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR   = join(__dirname, 'output');

// ── Sample rubric (mirrors rubric.json structure) ─────────────────────────────
const rubric = validateRubric({
  title: 'UOC Video Presentation Evaluation',
  language: 'ca',
  feedbackLanguage: 'ca',
  criteria: [
    {
      id: 'content_accuracy', name: 'Contingut i precisió', nameEn: 'Content & Accuracy',
      weight: 0.30, description: 'Accuracy and depth of content.',
      levels: [
        { score: 10, label: 'Excel·lent', description: 'All concepts correct and deep.' },
        { score:  7, label: 'Notable',    description: 'Mostly correct, minor gaps.' },
        { score:  5, label: 'Aprovat',    description: 'Core concepts present, uneven.' },
        { score:  0, label: 'Suspès',     description: 'Significant errors or gaps.' },
      ],
    },
    {
      id: 'structure_clarity', name: 'Estructura i claredat', nameEn: 'Structure & Clarity',
      weight: 0.20, description: 'Logical organisation and clarity of presentation.',
      levels: [
        { score: 10, label: 'Excel·lent', description: 'Perfectly structured.' },
        { score:  7, label: 'Notable',    description: 'Clear structure, minor issues.' },
        { score:  5, label: 'Aprovat',    description: 'Some structure present.' },
        { score:  0, label: 'Suspès',     description: 'Unclear or unstructured.' },
      ],
    },
    {
      id: 'oral_expression', name: "Expressió oral", nameEn: 'Oral Expression',
      weight: 0.20, description: 'Clarity of speech and natural delivery.',
      levels: [
        { score: 10, label: 'Excel·lent', description: 'Fluent and natural.' },
        { score:  7, label: 'Notable',    description: 'Mostly clear, occasional hesitation.' },
        { score:  5, label: 'Aprovat',    description: 'Understandable but monotone.' },
        { score:  0, label: 'Suspès',     description: 'Hard to follow.' },
      ],
    },
    {
      id: 'critical_analysis', name: "Anàlisi crítica", nameEn: 'Critical Analysis',
      weight: 0.20, description: 'Depth of argument and own perspective.',
      levels: [
        { score: 10, label: 'Excel·lent', description: 'Sophisticated critical stance.' },
        { score:  7, label: 'Notable',    description: 'Good analysis, limited depth.' },
        { score:  5, label: 'Aprovat',    description: 'Surface level analysis.' },
        { score:  0, label: 'Suspès',     description: 'No critical dimension.' },
      ],
    },
    {
      id: 'citations_references', name: 'Cites i referències', nameEn: 'Citations & References',
      weight: 0.10, description: 'Correct use of academic sources.',
      levels: [
        { score: 10, label: 'Excel·lent', description: 'All sources well cited.' },
        { score:  7, label: 'Notable',    description: 'Most sources cited correctly.' },
        { score:  5, label: 'Aprovat',    description: 'Some sources missing.' },
        { score:  0, label: 'Suspès',     description: 'No academic references.' },
      ],
    },
  ],
  gradingScale: [
    { min: 9.0, max: 10.0, label: 'Excel·lent (A)' },
    { min: 7.0, max:  8.9, label: 'Notable (B)'    },
    { min: 5.0, max:  6.9, label: 'Aprovat (C)'    },
    { min: 0.0, max:  4.9, label: 'Suspès (D)'     },
  ],
});

// ── Sample students ───────────────────────────────────────────────────────────
const students = [
  {
    id: 'pau_garcia',
    transcript: `Bon dia. La meva presentació tracta sobre la intel·ligència artificial i el seu impacte
en l'educació superior. Comencem amb una definició: la IA és la simulació de processos
d'intel·ligència humana per màquines, especialment sistemes informàtics.

Pel que fa als seus efectes en l'educació, podem identificar tres dimensions principals.
Primera, la personalització de l'aprenentatge: els sistemes d'IA poden adaptar els
continguts al ritme i estil de cada estudiant. Autors com Selwyn (2019) destaquen que
això pot reduir significativament les taxes d'abandó.

Segona dimensió: l'avaluació automatitzada. Ferramentes com els sistemes de feedback
instantani permeten als docents centrar-se en tasques de major valor pedagògic.

Tercera dimensió: els reptes ètics. La biaixos algorítmics i la privacitat de les dades
dels estudiants són problemes que la literatura recent aborda àmpliament (Luckin, 2018).

Per concloure, la IA ofereix oportunitats extraordinàries però requereix un marc ètic
sòlid. Les institucions han d'invertir en formació docent i en polítiques de govern
de dades. Gràcies.`,
    raw: JSON.stringify({
      rubricTitle: 'UOC Video Presentation Evaluation',
      evaluatedAt: new Date().toISOString(),
      language: 'ca',
      criteria: [
        { id: 'content_accuracy',    score: 8.5, name: 'Content & Accuracy',    weight: 0.30, justification: "El contingut és precís i ben documentat. L'estudiant demostra una comprensió sòlida de la IA i les seves aplicacions educatives, tot i que alguns conceptes podrien aprofundir-se més, com ara la distinció entre IA feble i forta." },
        { id: 'structure_clarity',   score: 8.0, name: 'Structure & Clarity',   weight: 0.20, justification: "La presentació segueix una estructura tripartita clara (definició, dimensions, conclusions) que facilita el seguiment. La transició entre les dimensions podria ser més fluida." },
        { id: 'oral_expression',     score: 7.5, name: 'Oral Expression',       weight: 0.20, justification: "L'expressió oral és generalment clara i intel·ligible. S'observen algunes pauses llargues i ocasionals tropells, però el to és adequat per a un context acadèmic." },
        { id: 'critical_analysis',   score: 7.0, name: 'Critical Analysis',     weight: 0.20, justification: "L'estudiant identifica els reptes ètics de la IA, especialment els biaixos algorítmics, la qual cosa demostra una aproximació crítica. Tanmateix, el posicionament propi sobre les solucions proposades podria ser més explícit." },
        { id: 'citations_references', score: 9.0, name: 'Citations & References', weight: 0.10, justification: "Utilitza fonts acadèmiques rellevants i actuals (Selwyn 2019, Luckin 2018) correctament integrades en el discurs." },
      ],
      weightedScore: 0,
      grade: '',
      overallFeedback: "Pau presenta una exposició ben estructurada i documentada sobre la IA en l'educació. Els punts forts són la solidesa del contingut i l'ús de fonts acadèmiques reconegudes. Per millorar: aprofundir en el posicionament crític propi i treballar la fluïdesa oral per reduir les pauses, la qual cosa reforçaria l'impacte de la presentació.",
    }),
  },
  {
    id: 'anna_puig',
    transcript: `Hola, avui parlaré sobre les energies renovables i la transició energètica a Catalunya.
La situació actual és preocupant: Catalunya genera només un 25% de la seva energia
des de fonts renovables, molt per sota dels objectius europeus del 42% per al 2030.

Les principals barreres que he identificat a la literatura són tres. Un: la intermitència
de les fonts solars i eòliques. Dos: la manca d'infraestructura d'emmagatzematge.
Tres: les resistències socials als parcs eòlics (fenomen NIMBY).

La meva proposta: implementar un programa de comunitats energètiques locals, seguint
el model de Dinamarca. Diversos estudis (IRENA, 2023; Agència Europea de Medi Ambient,
2022) demostren que aquest model augmenta l'acceptació social i redueix costos.

En conclusió, la transició és possible però requereix voluntat política, inversió en
emmagatzematge i participació ciutadana. Moltes gràcies.`,
    raw: JSON.stringify({
      rubricTitle: 'UOC Video Presentation Evaluation',
      evaluatedAt: new Date().toISOString(),
      language: 'ca',
      criteria: [
        { id: 'content_accuracy',    score: 9.0, name: 'Content & Accuracy',    weight: 0.30, justification: "Contingut molt precís i ben contextualitzat. Les dades citades (25%, objectiu 42%) són concretes i verificables. La identificació de les tres barreres és sistemàtica i ben fonamentada." },
        { id: 'structure_clarity',   score: 9.5, name: 'Structure & Clarity',   weight: 0.20, justification: "Excel·lent estructura: problema, barreres, proposta i conclusió. La numeració explícita de les barreres facilita molt la comprensió. La transició al model danès és natural i ben motivada." },
        { id: 'oral_expression',     score: 8.5, name: 'Oral Expression',       weight: 0.20, justification: "Dicció clara, ritme adequat i to convençut. La presentadora transmet seguretat en el tema. Lleugeres marques de lectura del guió en alguns fragments." },
        { id: 'critical_analysis',   score: 9.0, name: 'Critical Analysis',     weight: 0.20, justification: "Destaca l'anàlisi del fenomen NIMBY i la proposta concreta de comunitats energètiques com a solució. Demostra pensament crític i propositiu, no es limita a descriure el problema." },
        { id: 'citations_references', score: 8.0, name: 'Citations & References', weight: 0.10, justification: "Fonts solvents i actuals (IRENA 2023, AEMA 2022). Podria especificar millor el títol dels informes concrets citats." },
      ],
      weightedScore: 0,
      grade: '',
      overallFeedback: "Anna ofereix una presentació excel·lent per la seva concreció, estructura i capacitat propositiva. Domina el tema i ho transmet amb claredat i seguretat. El punt de millora principal és evitar llegir el guió i citar les fonts amb major precisió bibliogràfica.",
    }),
  },
  {
    id: 'marc_torres',
    transcript: `Buenas, voy a hablar sobre... el marketing digital y las redes sociales.
Bueno, pues las redes sociales son muy importantes hoy en día. Todo el mundo las usa.
Facebook, Instagram, TikTok... hay muchas. Las empresas las usan para anunciarse
y así llegar a más gente.

Hay diferentes tipos de marketing. Está el marketing de contenidos, que es cuando
haces contenido para atraer clientes. Y también el marketing de influencers.

Para hacer un buen marketing digital hay que tener en cuenta varias cosas.
Primero, conocer a tu público objetivo. Segundo, crear contenido de calidad.
Tercero, medir los resultados con métricas.

Básicamente eso es todo. El marketing digital es muy importante para las empresas
actuales y seguirá creciendo. Gracias.`,
    raw: JSON.stringify({
      rubricTitle: 'UOC Video Presentation Evaluation',
      evaluatedAt: new Date().toISOString(),
      language: 'ca',
      criteria: [
        { id: 'content_accuracy',    score: 5.0, name: 'Content & Accuracy',    weight: 0.30, justification: "El contingut és bàsic i superficial. Les afirmacions són correctes però molt generals ('tot el món les usa', 'molt important'). Manca qualsevol dada quantitativa, estadística o referència a estudis que donin consistència al discurs." },
        { id: 'structure_clarity',   score: 5.5, name: 'Structure & Clarity',   weight: 0.20, justification: "S'intueix una estructura (introducció, tipus, consells, conclusió) però no està ben delimitada. Les transicions entre parts són abruptes i la conclusió és molt pobra." },
        { id: 'oral_expression',     score: 4.5, name: 'Oral Expression',       weight: 0.20, justification: "L'expressió oral presenta moltes marques d'oralitat col·loquial ('bueno', 'pues', 'básicamente') inadequades per a un context acadèmic. El ritme és irregular i l'entusiasme escàs." },
        { id: 'critical_analysis',   score: 4.0, name: 'Critical Analysis',     weight: 0.20, justification: "No hi ha anàlisi crítica. El discurs és descriptiu i es limita a enumerar conceptes sense aprofundir-hi ni qüestionar-los. No s'observa cap posicionament propi." },
        { id: 'citations_references', score: 0.0, name: 'Citations & References', weight: 0.10, justification: "No s'ha citat cap font acadèmica ni referència bibliogràfica al llarg de tota la presentació. Això és un requisit fonamental en el context universitari." },
      ],
      weightedScore: 0,
      grade: '',
      overallFeedback: "La presentació de Marc cobreix el tema de forma molt superficial i sense suport acadèmic. Per millorar substancialment cal: incorporar fonts bibliogràfiques (articles, informes sectorials), aportar dades concretes, eliminar les marques de col·loquialisme oral i desenvolupar una postura crítica pròpia sobre el tema. La base conceptual és correcta però necessita molt de treball.",
    }),
  },
];

// ── Generate outputs ──────────────────────────────────────────────────────────
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const results = [];

for (const s of students) {
  const evaluation = validateEvaluation(s.raw, rubric);
  evaluation.evaluatedAt = new Date().toISOString();

  const studentDir = ensureStudentDir(OUT_DIR, s.id);
  await writeTranscript(studentDir, s.transcript, 'ca');
  await writeEvaluation(studentDir, evaluation);
  await writeFeedback(studentDir, evaluation, 'ca');

  results.push({ student: s.id, status: 'ok', evaluation });
  console.log(`✓  ${s.id.padEnd(20)} ${String(evaluation.weightedScore).padEnd(6)} ${evaluation.grade}`);
}

const { default: path } = await import('path');
const csvPath = await writeCsv(OUT_DIR, results, rubric);

console.log(`\nCSV  → ${csvPath}`);
console.log(`Dir  → ${OUT_DIR}/\n`);
console.log('Open output/<student>/feedback_ca.txt to see the full evaluation letter.');
