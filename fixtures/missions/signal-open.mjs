import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { verifyMission } from '../../src/mission-verifier.mjs';
import { browserAvailable, launchBrowser } from '../../src/browser.mjs';

/**
 * Signal, underspecified: the same product as `signal-analytics`, with the design left in.
 *
 * The other mission hands over a contract -- eight module boundaries, every signature, every
 * default, every refusal code -- and then grades the transcription of it. A submission that
 * follows the contract perfectly scores 27/27 whether or not the contract is good, and the fleet
 * that scored 27/27 twice had no way to say that the contract was ambiguous, because a judge made
 * of assertions has no channel for pushback.
 *
 * This mission hands over the *problem*. A customer's page, a sentence of intent, and the product
 * facts that make it runnable and observable. Nothing about how. The submission decides what to
 * collect, what to call it, how to batch it, what to store, and what the owner sees.
 *
 * Which means the judge cannot be a list of function signatures. It is a browser.
 *
 * What the judge does
 *
 * A real Chrome visits the submission's own server twice: a calm visit to a second page, then a
 * visit that scrolls, rage-clicks a dead button, types a card number, and triggers a real uncaught
 * exception in the page's own code. Then the judge reads the dashboard the owner would read, and
 * checks the wire the tag actually produced. The expectations are not in the submission's
 * vocabulary -- no event name, no schema, no field. They are the facts any analytics product that
 * works would have to establish: the page that was visited appears, the error the visitor saw
 * appears, and nothing the visitor typed or the page marked private appears anywhere.
 *
 * What the judge deliberately does not score
 *
 * Scroll depth and rage clicks are the two figures the other mission checks arithmetically, and
 * this one does not check at all. Asserting them here would mean guessing the submission's
 * vocabulary -- "the deepest depth reached is shown as a percentage between 50 and 100" is a design
 * decision, not an observable fact -- and a looser version ("a number the calm visit did not have")
 * is satisfied by any dashboard that prints a timestamp. A check that a static dashboard passes is
 * worse than no check, because it reads as evidence. The mission document records both as
 * unscored, and the blind review is where a human judges whether the owner can actually tell what
 * happened.
 *
 * So this judge is a floor: it can prove the product runs, is instrumented, reports, and keeps
 * nothing it must not. It cannot prove the dashboard is good. That is the honest split, and it is
 * stated here rather than implied by a score.
 *
 * The cost of judging this way
 *
 * The judge runs the submission as a *program*, not as an isolated function: the server is spawned
 * with the permission model bounded to its own workspace plus the network it needs to listen, and
 * a browser loads what it serves. That is a weaker isolation than `mission_invocation_*` and it is
 * recorded as such rather than implied away. A submission that hangs is killed by deadline.
 */

const TAG_BUDGET_BYTES = 12 * 1024;
const SERVER_READY_MS = 8000;
const SECRET = '4111 1111 1111 1111';
const EMAIL = 'owner@chesterhill.example';
const PRIVATE_TEXT = 'internal note: do not record';
const ERROR_TEXT = 'Cannot read properties of undefined (reading "total") <img src=x onerror=alert(1)>';
const RAGE_SELECTOR = '#buy';
const OUTBOUND_HREF = 'https://calendly.example.test/chesterhill';

const brief = `Build Signal: a lightweight first-party site analytics platform for the demo site in site/.

A customer pastes one small tag on every page of every site they own. The tag reports what a visitor did; a small ingest keeps it; a dashboard answers the only question an owner has -- what is working, and what is not. The reference capability is Microsoft Clarity: session replay, rage clicks, dead clicks, scroll depth, JavaScript errors, engagement. Match what it shows an owner, at a fraction of the weight, with nobody else in the data path.

You decide the design. There is no required module layout, event schema, storage shape or dashboard markup. Choose what to collect, how to batch and send it, how to store it, and what the owner sees. Design the product you would want to use.

What is fixed, because an observer has to be able to look at it:
- node server.mjs starts the platform on the port in $PORT, with no arguments and no build step.
- Visiting / and /campaigns serves those pages from site/, and the page it serves carries your tag -- the customer's own files must not be edited.
- GET /dashboard serves the owner's dashboard.
- The tag is at most 12 KB gzipped, and it loads from your server: no third-party host in the data path.
- Nothing a visitor types is ever kept or sent, and an element the page marks data-private is never recorded.

site/index.html and site/campaigns.html are the customer's pages, with their own behaviour: a button that does nothing, a link that leaves the site, a form, a private note, and a button that throws. They are protected files: instrument them from the outside.

The platform is judged by a real browser visiting your server and by what an owner can learn from the dashboard -- not by the shape of your code. Finish the whole product: a tag that is not served is not a product, and a dashboard that does not show what happened is not one either.`;

const body = `<header class="site-header"><h1>Chester Hill Solutions</h1><p class="lede">Campaign operations, measured.</p></header>
<section class="hero"><h2>Run better campaigns</h2><p>We plan, buy and measure.</p>
<button id="buy" class="cta" type="button">Start a campaign</button>
<a id="calendly" class="cta secondary" href="${OUTBOUND_HREF}">Book a call</a></section>
<section class="pricing"><h2>Pricing</h2><p>Monthly retainers from $2,400.</p>
<button id="buy-pricing" class="cta" type="button">Choose a plan</button></section>
<section class="filler" aria-hidden="true"></section>`;

const page = name => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · Chester Hill Solutions</title>
<link rel="stylesheet" href="/site/style.css">
</head>
<body>
<main>
${body}
<form id="signup" action="#" method="post">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off">
<label for="card">Card</label><input id="card" name="card" type="text" inputmode="numeric" autocomplete="off">
<p data-private>${PRIVATE_TEXT}</p>
<button id="explode" type="button">Load report</button>
</form>
</main>
<script>
document.getElementById('explode').addEventListener('click', () => {
  throw new Error(${JSON.stringify(ERROR_TEXT)});
});
</script>
</body>
</html>
`;

const style = `:root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; color: #14181f; }
main { max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
.site-header { padding: 1.5rem 0; border-bottom: 1px solid #e3e7ee; }
h1 { font-size: 1.5rem; margin: 0; }
.lede { color: #5a6472; margin: .35rem 0 0; }
.hero, .pricing { padding: 2.5rem 0; border-bottom: 1px solid #eef1f6; }
.cta { display: inline-block; margin: .75rem .5rem 0 0; padding: .7rem 1.1rem; border: 1px solid #14181f; border-radius: .5rem; background: #14181f; color: #fff; font: inherit; text-decoration: none; cursor: pointer; }
.cta.secondary { background: #fff; color: #14181f; }
form { padding: 2rem 0; display: grid; gap: .4rem; max-width: 22rem; }
input { padding: .55rem .7rem; border: 1px solid #c9d0da; border-radius: .4rem; font: inherit; }
.filler { height: 1600px; }
`;

const files = {
  'BRIEF.md': brief,
  'site/index.html': page('Home'),
  'site/campaigns.html': page('Campaigns'),
  'site/style.css': style,
  'server.mjs': `// Serve the demo site with the tag in it, the tag itself, the ingest, and the dashboard.
// See BRIEF.md. Replace this stub.
throw new Error('Not implemented');
`,
  'public/signal.js': `/* The tag. See BRIEF.md. Replace this stub. */
`,
  'public/dashboard.css': `/* The owner dashboard. See BRIEF.md. */
`,
  'README.md': `# Signal

Describe how to run the platform and how a customer embeds the tag. Replace this stub.
`,
};

const editablePaths = ['server.mjs', 'public/signal.js', 'public/dashboard.css', 'README.md'];

const streams = [
  ['instrumentation', 'The tag on the page', 'Make the tag run on the customer\'s page without editing it: it must not block rendering, must survive a page that throws, and must be small enough to paste. You decide how it is delivered and configured.', ['public/signal.js']],
  ['interaction-signals', 'What the visitor did', 'Decide which interactions are worth recording and what makes one signal different from another: a click that changed the page, a click that did nothing, a repeated frustrated click, how far the page was read, a link that left the site. You decide the vocabulary and the thresholds.', ['public/signal.js']],
  ['error-capture', 'What broke', 'Capture the errors a visitor actually saw, with enough context to fix them, without letting a noisy page flood the store. You decide the shape.', ['public/signal.js']],
  ['privacy', 'What must never be recorded', 'Nothing typed by a visitor is kept or sent, and an element the page marks private is never recorded, at any depth. This is the requirement that a working product and a lawsuit have in common; it is judged on the wire and in the store, not in a comment.', ['public/signal.js']],
  ['transport', 'Getting it off the page', 'Decide how events leave the page: batching, size, what happens on unload, what happens when the network is gone. You decide the wire format.', ['public/signal.js']],
  ['ingest-and-store', 'The receiving end', 'Validate what arrives, refuse what is wrong, and keep what is right in a shape the dashboard can read. You decide the schema and the retention.', ['server.mjs']],
  ['dashboard', 'What the owner sees', 'Answer the owner\'s question -- what is working and what is not -- for the pages they own. You decide the layout, the figures and the wording. Escape everything dynamic.', ['server.mjs', 'public/dashboard.css']],
  ['run-and-document', 'Runnable and documented', 'One command starts it, and the README tells a customer how to paste the tag and what they will see. A product nobody can start is not a product.', ['server.mjs', 'README.md']],
];

const criteria = [
  'runs-in-one-command',
  'serves-the-demo-pages',
  'page-carries-the-tag',
  'tag-within-budget',
  'tag-runs-clean',
  'records-the-visit',
  'records-the-error',
  'dashboard-escapes-the-error',
  'never-collects-typed-values',
  'respects-the-private-subtree',
  'no-third-party-in-the-data-path',
  'embed-instructions',
];

function fixture() {
  const workstreams = streams.map(([id, role, description, paths]) => ({
    id,
    role,
    brief: `${description} Read BRIEF.md and the customer's pages. The design is yours; workstream focus is not exclusive ownership, and you may add files.`,
    paths,
    dependencies:
      id === 'ingest-and-store' ? [{ producerPath: 'public/signal.js', consumerPath: 'server.mjs' }]
        : id === 'dashboard' ? [{ producerPath: 'server.mjs', consumerPath: 'public/dashboard.css' }]
          : [],
  }));
  return {
    id: 'signal-open',
    title: 'Signal, underspecified: an analytics product judged by a browser',
    domain: 'analytics',
    goal: brief,
    files,
    protectedPaths: Object.keys(files).filter(path => !editablePaths.includes(path)),
    editablePaths,
    criteria: criteria.map(id => ({ id, description: id.replaceAll('-', ' ') })),
    workstreams,
    evaluatorTimeoutMs: 30000,
    // No reviewInvocation: the blind review's rendered sample is a string, and this mission's
    // artifact is a running server. Its reviewable form is a served instance and the dashboard a
    // reviewer opens against it, which is why the flight records a screenshot per cohort.
  };
}

export const signalOpenMissions = [fixture()];

// --- grading -------------------------------------------------------------------

/** A port nobody is using, so two cohorts can be graded at once. */
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Poll the submission's server until it answers, or the deadline passes. */
async function waitForServer(port, deadlineMs) {
  const until = Date.now() + deadlineMs;
  let last = 'no response';
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (response.status < 500) return { ok: true, status: response.status };
      last = `status ${response.status}`;
    } catch (error) { last = error.message; }
    await sleep(150);
  }
  return { ok: false, detail: last };
}

const get = async (port, path) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
  return { status: response.status, headers: response.headers, text: await response.text() };
};

export async function verifySignalOpenMission(id, root) {
  const mission = signalOpenMissions.find(value => value.id === id);
  if (!mission) throw new Error('Unknown analytics mission');
  // A machine without a browser cannot judge this mission, and that is a fact about the host.
  // Reported the way the isolated verifier reports a runtime without the permission model, so a
  // submission is never blamed for the instrument being absent.
  if (!browserAvailable()) {
    return {
      correct: false,
      isolationRefused: true,
      checks: [...mission.criteria.map(criterion => ({ name: criterion.id, passed: false })), { name: 'evaluator_refused_browser_unavailable', passed: false }],
      instructionChecks: [],
    };
  }
  return verifyMission(mission, root, async tools => { await gradeDesign(root, tools); });
}

/**
 * The whole grading pass: run the submission, visit it twice, read what the owner would read.
 *
 * Every check fails for one reason. A server that never starts fails `runs-in-one-command` and the
 * browser checks, and nothing here pretends otherwise; a dashboard that shows nothing fails the
 * record checks and not the privacy ones. The order is the order a reviewer would use.
 */
async function gradeDesign(root, { check, readText }) {
  const readme = await readText('README.md').catch(() => '');
  // The permission model compares real paths, and a temp directory is usually a symlink: granting
  // the path we were handed would deny the submission its own entry module.
  const workspace = await realpath(root);
  const port = await freePort();
  const server = spawn(process.execPath, [
    '--permission',
    `--allow-fs-read=${workspace}`,
    `--allow-fs-write=${workspace}`,
    '--allow-net',
    'server.mjs',
  ], {
    cwd: workspace,
    // A minimal environment: the port, and enough to find Node. No provider credential, no
    // workspace token, nothing a submission could exfiltrate if it tried.
    env: { PORT: String(port), PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout?.on('data', chunk => logs.push(String(chunk)));
  server.stderr?.on('data', chunk => logs.push(String(chunk)));
  const startedAt = Date.now();
  let browser;
  try {
    const ready = await waitForServer(port, SERVER_READY_MS);
    const startupMs = Date.now() - startedAt;

    await check('runs-in-one-command', () => {
      assert.ok(ready.ok, `node server.mjs did not answer on $PORT within ${SERVER_READY_MS}ms (${ready.detail}): ${logs.join('').slice(0, 400)}`);
      assert.ok(startupMs <= SERVER_READY_MS, `startup took ${startupMs}ms`);
    });

    // Everything below needs a page. A server that is not up is not asked to serve one.
    if (!ready.ok) return;

    const home = await get(port, '/').catch(error => ({ status: 0, text: error.message }));
    const campaigns = await get(port, '/campaigns').catch(error => ({ status: 0, text: error.message }));
    await check('serves-the-demo-pages', () => {
      assert.equal(home.status, 200, `/ answered ${home.status}`);
      assert.match(home.text, /Chester Hill Solutions/, 'the served page is not the customer\'s page');
      assert.match(home.text, /id="buy"/, 'the served page lost the customer\'s markup');
      assert.equal(campaigns.status, 200, `/campaigns answered ${campaigns.status}`);
      assert.match(campaigns.text, /id="buy"/, 'the second page lost the customer\'s markup');
    });

    // The tag is discovered from the page the submission serves, not from a path the brief named:
    // the product is "the page carries the tag", and a page that does not is not instrumented.
    const sources = [...home.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(match => match[1]);
    let tag = null;
    let tagSource = '';
    for (const source of sources) {
      let url;
      try { url = new URL(source, `http://127.0.0.1:${port}/`); } catch { continue; }
      if (url.host !== `127.0.0.1:${port}`) continue;
      const response = await get(port, url.pathname + url.search).catch(() => null);
      if (response?.status === 200 && response.text.trim()) { tag = url.pathname; tagSource = response.text; break; }
    }

    await check('page-carries-the-tag', () => {
      assert.ok(tag, `the served page references no script this server serves (found: ${sources.join(', ') || 'none'})`);
    });
    await check('tag-within-budget', () => {
      assert.ok(tag, 'there is no tag to weigh');
      const bytes = gzipSync(Buffer.from(tagSource)).length;
      assert.ok(bytes <= TAG_BUDGET_BYTES, `the tag is ${bytes} bytes gzipped, over the ${TAG_BUDGET_BYTES} budget`);
    });

    browser = await launchBrowser({ timeoutMs: 20000 });
    const base = `http://127.0.0.1:${port}`;
    const drive = async (path, actions) => {
      await browser.navigate(base + path);
      await sleep(400);
      for (const action of actions) {
        try { await action(); } catch (error) { logs.push(`interaction: ${error.message}`); }
        await sleep(120);
      }
      // Leave the page the way a visitor does, so an unload beacon gets its chance.
      await sleep(700);
      await browser.navigate('about:blank').catch(() => {});
    };

    // A calm visit to the second page, then the visit that should look worse.
    await drive('/campaigns', []);
    const dashboardA = await get(port, '/dashboard').catch(error => ({ status: 0, text: error.message }));
    await drive('/', [
      () => browser.evaluate('(window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * 0.6), window.scrollY)'),
      async () => { for (let index = 0; index < 4; index += 1) await browser.click(RAGE_SELECTOR); },
      () => browser.type('#email', EMAIL),
      () => browser.type('#card', SECRET),
      () => browser.click('#explode'),
      () => browser.click('#calendly'),
    ]);
    const dashboardB = await get(port, '/dashboard').catch(error => ({ status: 0, text: error.message }));

    const page = dashboardB.text ?? '';
    const calm = dashboardA.text ?? '';
    const wire = browser.requests.map(request => `${request.url}\n${request.body ?? ''}`).join('\n');
    const everyResponse = `${page}\n${calm}`;

    await check('tag-runs-clean', () => {
      // The page's own thrown error is expected; the filter names it so a tag that also threw is
      // not excused by it.
      const ours = browser.exceptions.filter(exception => !exception.text.includes('onerror=alert(1)'));
      assert.deepEqual(ours.map(exception => exception.text.slice(0, 160)), [], 'the tag threw while a visitor used the page');
    });
    await check('records-the-visit', () => {
      assert.equal(dashboardB.status, 200, `/dashboard answered ${dashboardB.status}`);
      assert.ok(page.includes('/campaigns'), 'the dashboard does not show the page that was visited');
      assert.ok(page.includes('Chester Hill Solutions') || page.includes('/'), 'the dashboard names no site and no page');
    });
    await check('records-the-error', () => {
      assert.ok(page.includes('Cannot read properties of undefined'), 'the error the visitor saw is not in the dashboard');
    });
    await check('dashboard-escapes-the-error', () => {
      assert.ok(!page.includes('<img src=x onerror='), 'the dashboard rendered the error message as markup');
    });
    await check('never-collects-typed-values', () => {
      assert.ok(!wire.includes(SECRET), 'the card number was sent over the wire');
      assert.ok(!wire.includes(EMAIL), 'the email address was sent over the wire');
      assert.ok(!everyResponse.includes(SECRET), 'the card number is in a dashboard');
      assert.ok(!everyResponse.includes(EMAIL), 'the email address is in a dashboard');
    });
    await check('respects-the-private-subtree', () => {
      assert.ok(!wire.includes(PRIVATE_TEXT), 'the private subtree was sent over the wire');
      assert.ok(!everyResponse.includes(PRIVATE_TEXT), 'the private subtree is in a dashboard');
    });
    await check('no-third-party-in-the-data-path', () => {
      const foreign = browser.requests
        .filter(request => request.type !== 'Document')
        .map(request => { try { return new URL(request.url); } catch { return null; } })
        .filter(url => url && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && !url.protocol.startsWith('data'))
        .map(url => url.href);
      assert.deepEqual(foreign, [], `the tag talked to ${foreign.join(', ')}`);
    });
    await check('embed-instructions', () => {
      assert.match(readme, /<script/i, 'the README shows no snippet a customer could paste');
      assert.match(readme, /node\s+server\.mjs/i, 'the README does not say how to start it');
    });
  } finally {
    await browser?.close();
    try { server.kill('SIGKILL'); } catch { /* already dead */ }
  }
}
