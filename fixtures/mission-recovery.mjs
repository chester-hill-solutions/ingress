/**
 * The recovery mission: a three-stream project whose outputs declare what they were built from.
 *
 * Why it exists as a fixture rather than inside the driver
 *
 * The participant commands are the mission. If they live inside `scripts/mission-recovery.mjs`,
 * the only way to find out whether they emit what the mission expects is to boot real
 * containers and pay for the answer — and a mission whose tools are wrong would fail as a
 * product failure. Here they are data, so the tools can be run in a temp directory, on Node,
 * with no account and no container, and the *only* thing the live run adds is the product.
 *
 * The shape it is built to produce
 *
 *   config/policy.json   the source. Declared built from nothing, so it can never be invalidated.
 *   src/report.mjs       built from the policy, and its value changes when the policy does.
 *   src/summary.mjs      built from the report -- the transitive case, two hops from the source.
 *   src/notes.mjs        built from the policy, and its value does *not* change when the policy
 *                        does. That is the over-invalidation case the campaign measured: the
 *                        dependency is real, the work is not needed, and the tax has to show it.
 *
 * Each generator writes its declaration to `.ingress/built-from.json`, which the launcher
 * attaches to the manifest at commit time and the reporter never sends as content.
 */

const declareTool = `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/**
 * The revisions the workspace handed this container, written by the launcher at seed time.
 *
 * \`null\` when the file is missing, which the launcher announces as \`INGRESS-BASE-UNKNOWN\`.
 * Returning an empty object instead would make "I was handed nothing" indistinguishable from
 * "I was handed these paths at revision one".
 */
export function revisions() {
  try {
    return JSON.parse(readFileSync(process.env.INGRESS_REVISIONS_PATH || '/tmp/ingress-revisions.json', 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Declare what one output was built from, given the inputs it read.
 *
 * Returns false when no honest claim can be made: without the revisions the workspace handed
 * this container there is no revision to cite, and a guessed one would be a false statement
 * about the work. A false return leaves the output *uncovered* in the workspace's record,
 * which is the honest answer, and the caller says so on stdout.
 *
 * The declaration file is read by the launcher at commit time. It lives under \`.ingress/\`,
 * which the reporter never sends, so this is a claim about the work rather than a change to it.
 */
export function declare(output, inputPaths) {
  const handed = revisions();
  if (handed === null) return false;
  const inputs = [];
  for (const path of inputPaths) {
    const revision = handed[path];
    if (!Number.isSafeInteger(revision)) return false;
    inputs.push({ path, revision });
  }
  mkdirSync('.ingress', { recursive: true });
  let declared = {};
  try { declared = JSON.parse(readFileSync('.ingress/built-from.json', 'utf8')); } catch { /* first declaration here */ }
  declared[output] = inputs;
  writeFileSync('.ingress/built-from.json', JSON.stringify(declared, null, 2) + '\\n');
  return true;
}
`;

const emitReport = `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { declare } from './declare.mjs';

const policy = JSON.parse(readFileSync('config/policy.json', 'utf8'));
mkdirSync('src', { recursive: true });
writeFileSync('src/report.mjs',
  '// generated from config/policy.json\\n' +
  'export const offer = ' + policy.offer + ';\\n' +
  'export const currency = ' + JSON.stringify(policy.currency) + ';\\n');

// Built from the policy at the revision this container was handed. That is the claim the
// whole mechanism rests on, and it is made by the participant that did the work.
if (!declare('src/report.mjs', ['config/policy.json'])) console.log('REPORT_UNDECLARED no revision was handed for config/policy.json');
console.log('REPORT_EMITTED offer=' + policy.offer);
`;

const emitNotes = `import { writeFileSync, mkdirSync } from 'node:fs';
import { declare } from './declare.mjs';

mkdirSync('src', { recursive: true });
writeFileSync('src/notes.mjs', 'export const note = "policy reviewed";\\n');

// Depends on the policy for the *review*, not for the value. This is the case the campaign
// measured as over-invalidation: the input genuinely moves and this output does not change, so
// the mechanism asks for work it cannot need and the tax records it.
if (!declare('src/notes.mjs', ['config/policy.json'])) console.log('NOTES_UNDECLARED no revision was handed for config/policy.json');
console.log('NOTES_EMITTED');
`;

const emitSummary = `import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { declare } from './declare.mjs';

const report = readFileSync('src/report.mjs', 'utf8');
const offer = Number(/offer = (\\d+)/.exec(report)[1]);
mkdirSync('src', { recursive: true });
writeFileSync('src/summary.mjs', 'export const total = ' + offer + ';\\n');

// Built from the report, which is built from the policy: the transitive case.
if (!declare('src/summary.mjs', ['src/report.mjs'])) console.log('SUMMARY_UNDECLARED no revision was handed for src/report.mjs');
console.log('SUMMARY_EMITTED total=' + offer);
`;

const bumpPolicy = `import { readFileSync, writeFileSync } from 'node:fs';
import { declare } from './declare.mjs';

const offer = Number(process.argv[2]);
const policy = JSON.parse(readFileSync('config/policy.json', 'utf8'));
policy.offer = offer;
writeFileSync('config/policy.json', JSON.stringify(policy, null, 2) + '\\n');

// A source, and it reads nothing. Declared explicitly as built from nothing so it is covered
// and can never be invalidated -- the same opt-out the fence accepts at admission. This one
// needs no revision, so it is declared whether or not the revisions file was there.
if (!declare('config/policy.json', [])) console.log('POLICY_UNDECLARED');
console.log('POLICY_BUMPED offer=' + offer);
`;

const product = `# Release policy service

- \`config/policy.json\` is the source of truth for the offer.
- \`src/report.mjs\` is generated from it by \`tools/emit-report.mjs\`.
- \`src/summary.mjs\` is generated from the report by \`tools/emit-summary.mjs\`.
- \`src/notes.mjs\` records that the policy was reviewed by \`tools/emit-notes.mjs\`.

Every generated file declares the revision of each input it was built from, in
\`.ingress/built-from.json\`, which the launcher reads at commit time.
`;

/** The files the mission starts with. The source is at revision 1 and the outputs do not exist. */
export const recoveryMissionFiles = Object.freeze({
  'PRODUCT.md': product,
  'config/policy.json': `${JSON.stringify({ offer: 10, currency: 'CAD' }, null, 2)}\n`,
  'tools/declare.mjs': declareTool,
  'tools/emit-report.mjs': emitReport,
  'tools/emit-notes.mjs': emitNotes,
  'tools/emit-summary.mjs': emitSummary,
  'tools/bump-policy.mjs': bumpPolicy,
});

/**
 * The participants. `policy` publishes only when the mission moves the source.
 *
 * The order matters and is the mission's: `report` and `notes` read the source, and `summary`
 * reads the report, so a recovery wave must republish the report before the summary or the
 * summary would be built from the bytes it was already built from.
 */
export const recoveryMissionTasks = Object.freeze({
  report: { output: 'src/report.mjs', reads: ['config/policy.json'], command: 'cd /workspace && node tools/emit-report.mjs', emits: 'REPORT_EMITTED' },
  notes: { output: 'src/notes.mjs', reads: ['config/policy.json'], command: 'cd /workspace && node tools/emit-notes.mjs', emits: 'NOTES_EMITTED' },
  summary: { output: 'src/summary.mjs', reads: ['src/report.mjs'], command: 'cd /workspace && node tools/emit-summary.mjs', emits: 'SUMMARY_EMITTED' },
  policy: { output: 'config/policy.json', reads: [], command: offer => `cd /workspace && node tools/bump-policy.mjs ${offer}`, emits: 'POLICY_BUMPED' },
});

/** What the mission claims it produces, in the terms the recovery plan needs. */
export const recoveryMissionOutputs = Object.freeze([
  { path: 'src/report.mjs', task: 'report' },
  { path: 'src/notes.mjs', task: 'notes' },
  { path: 'src/summary.mjs', task: 'summary' },
]);

/** The exact bytes each output must hold at a given offer. Exact, so a near-miss is a failure. */
export const recoveryMissionExpected = offer => ({
  'src/report.mjs': `// generated from config/policy.json\nexport const offer = ${offer};\nexport const currency = "CAD";\n`,
  'src/notes.mjs': 'export const note = "policy reviewed";\n',
  'src/summary.mjs': `export const total = ${offer};\n`,
});

/**
 * What a *model* is asked to produce, per task.
 *
 * The prompt names the file the model must write and what it must export, and says nothing
 * about how. The reads are the files the harness places in the model's working directory
 * before the turn: a model that cannot see the input cannot derive an output from it, and the
 * whole mission is about an output derived from an input.
 *
 * `notes` is asked for a constant on purpose, and says so. The interesting case is an output
 * whose *dependency is real and whose value does not depend on the change*, and a prompt that
 * left that to the model's judgement would measure the model's mood rather than the mechanism.
 */
export const recoveryMissionPrompts = Object.freeze({
  report: {
    reads: ['config/policy.json'],
    prompt: [
      'In this directory there is `config/policy.json`.',
      'Write `src/report.mjs`: an ES module that exports `offer` (the number in the policy)',
      'and `currency` (the string in the policy).',
      'Do not write anything else. Stop once the file is written.',
    ].join(' '),
  },
  notes: {
    reads: ['config/policy.json'],
    prompt: [
      'In this directory there is `config/policy.json`.',
      'Write `src/notes.mjs`: an ES module that exports `note` equal to the string "policy reviewed".',
      'Its value must not depend on the contents of the directory.',
      'Do not write anything else. Stop once the file is written.',
    ].join(' '),
  },
  summary: {
    reads: ['src/report.mjs'],
    prompt: [
      'In this directory there is `src/report.mjs`.',
      'Write `src/summary.mjs`: an ES module that exports `total` equal to the `offer` value in `src/report.mjs`.',
      'Do not write anything else. Stop once the file is written.',
    ].join(' '),
  },
});

/**
 * Whether a *model's* output satisfies the mission, checked on meaning rather than bytes.
 *
 * The deterministic generators are held to the exact bytes of `recoveryMissionExpected`,
 * because they are ours and a difference is a defect. A model's output is held to the value it
 * exports, because formatting is the model's to choose and holding it to a byte layout would
 * measure obedience rather than the mission. What is *not* relaxed is the value: `offer` must
 * be the policy's number, `total` must be the report's, and the notes must say what they say.
 *
 * The checks are deliberately strict about *what is exported* and loose about everything else,
 * so an output that happens to mention the right number in a comment does not pass.
 */
const exported = (source, name) => {
  const assignment = new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`, 'm').exec(source)
    ?? new RegExp(`\\b${name}\\s*=\\s*([^;\\n]+)`, 'm').exec(source);
  return assignment ? assignment[1].trim() : null;
};

export const recoveryMissionVerify = Object.freeze({
  report: (source, offer) => {
    const value = exported(source, 'offer');
    return value !== null && Number(value) === offer && /CAD/.test(exported(source, 'currency') ?? '');
  },
  notes: source => (exported(source, 'note') ?? '').includes('policy reviewed'),
  summary: (source, offer) => {
    const value = exported(source, 'total');
    return value !== null && Number(value) === offer;
  },
});

export const recoveryMission = Object.freeze({
  id: 'recovery-policy',
  title: 'Release policy service: a source, two dependents and a transitive one',
  initialOffer: 10,
  files: recoveryMissionFiles,
  tasks: recoveryMissionTasks,
  outputs: recoveryMissionOutputs,
  expected: recoveryMissionExpected,
  prompts: recoveryMissionPrompts,
  verify: recoveryMissionVerify,
});
