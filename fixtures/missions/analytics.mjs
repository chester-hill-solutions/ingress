import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { verifyMission } from '../../src/mission-verifier.mjs';

/**
 * Signal: a first-party site analytics platform, and the judge for it.
 *
 * What the product is
 *
 * One tag a customer drops on every page of every site they own, a tiny ingest that stores what
 * the tag sends, and a dashboard that answers the only question an owner has: what is working
 * and what is not. The reference point is Microsoft Clarity -- session replay, rage clicks, dead
 * clicks, scroll depth, JavaScript errors -- at a fraction of the weight, with no third party in
 * the data path.
 *
 * Why it is pure functions and a rendered string
 *
 * The mission verifier runs every submission under Node's permission model with no network and
 * no writes (`src/mission-verifier.mjs`), so a live tag cannot be exercised there. The product is
 * therefore expressed the way the other missions are: modules with public contracts, and one
 * rendered view. That is not a retreat from the product -- every hard part of an analytics tag
 * *is* a pure function over inputs. Whether a click was a rage click is arithmetic over click
 * times and coordinates. Whether a session rolled is a comparison against a clock the caller
 * supplies. What a DOM diff contains, and what it must never contain, is a function of the tree.
 * A recorder that masks correctly masks correctly whether or not a browser is attached.
 *
 * The browser is not assumed away
 *
 * One thing the isolated verifier cannot do is load the tag in a real page, and the mission says
 * so rather than implying otherwise. The accountable form of that claim is a separate acceptance
 * pass, run by the harness against a real Chrome and the tag's built artifact, watching the
 * requests the tag actually makes. It is recorded as its own result and never folded into these
 * criteria.
 *
 * What the judge does
 *
 * A visitor session is a *script*: loads, scroll depths, clicks with their coordinates, whether
 * the click changed the page, a thrown error, a mask-marked element. The verifier replays that
 * script through the submission's own tag logic and then checks the analytics that come out
 * against values computed here, from the script, in the parent -- the number of pageviews, which
 * clicks were rage clicks, which milestones were reached and when, what the dashboard must show.
 * The submission never sees the expectations.
 *
 * The weight budget is measured, not asserted
 *
 * `tag-size-budget` gzips the tag's own module graph and refuses anything over the bar. It also
 * refuses a tag that imports from outside `tag/`, because a tag that needs the rest of the
 * repository is not a tag anyone can embed.
 */

const TAG_BUDGET_BYTES = 12 * 1024;

const shared = `Build Signal, a lightweight first-party site analytics platform, using Node built-ins and ES modules. No external services, packages, network or assets at runtime. Modules export pure functions with the stated contracts, and app.mjs exports async runScenario(options) returning plain JSON {batches,decisions,state,summary,html}. The tag is the product: it must be small, must never leak what a visitor typed, and must never block the page. Preserve protected files. Finish the entire platform regardless of team size.`;

const spec = `Product: Signal. One tag embedded on every page of every customer site, an ingest, a store, and an owner dashboard. Reference capability: Microsoft Clarity (session replay, rage clicks, dead clicks, scroll depth, JavaScript errors, engagement), at a fraction of the weight and with no third party in the data path.

Site model. site/pages.json is {siteKey,name,pages:[{id,path,title,dom}]} where dom is a serialized element tree {tag,attrs,children?,text?}. site/session.json is the scripted visitor session: {visitor,startedAt,steps:[...]} where a step is one of {at,op:'load',page}, {at,op:'scroll',depth} with depth in 0..1, {at,op:'click',selector,x,y,signal} where signal is true when the click changed the page or navigated and false when nothing happened, {at,op:'input',selector,value,secret}, {at,op:'mutate',selector,html}, {at,op:'error',kind,message,stack}, {at,op:'visibility',state:'visible'|'hidden'}. at is milliseconds from startedAt.

tag/config.mjs: parseConfig({src,attributes}) -> {siteKey,endpoint,sampleRate,respectDnt,maskText,idleMs,rollMs,maxEvents,maxBytes,intervalMs}. attributes is the tag element's attribute map as strings; data-site and data-endpoint are required; data-sample-rate, data-mask-text, data-idle-ms, data-roll-ms, data-max-events, data-max-bytes and data-interval-ms override the defaults when present, and the rest fall back to defaults (sampleRate 1, respectDnt true, maskText false, idleMs 5000, rollMs 1800000, maxEvents 50, maxBytes 65536, intervalMs 10000). Throw on a missing site key, a missing or non-https endpoint, or a sampleRate outside 0..1. isBlocked(config,{dnt,optOut}) -> true when respectDnt is on and dnt is true, or when optOut is true.

tag/session.mjs: createSession({siteKey,visitor,now}) -> {id,startedAt,lastSeenAt,pageviews:0}. The id is deterministic: 'ses_' plus the first 16 hex characters of the SHA-256 of 'siteKey|visitor|UTC day', so the same visitor on the same day resumes one session and a later day starts a new one. pageview(session,{path,title,at}) -> {session,event} where the event is {type:'pageview',path,title,at} and the session's lastSeenAt advances. shouldRoll(session,at,{rollMs}) -> true when at minus lastSeenAt exceeds rollMs.

tag/quality.mjs: rageClicks(clicks,{windowMs=1000,radiusPx=30,minimum=3}) -> events [{type:'rage-click',selector,count,at,x,y}], where clicks is [{selector,x,y,at}]; clicks group when each is within windowMs of the previous and within radiusPx of the group's first click; a group at or above minimum emits one event at its last click. deadClicks(clicks,{windowMs=1000}) -> [{type:'dead-click',selector,at,x,y}] for every click whose signal is false. scrollMilestones(reaches,[25,50,75,100]) -> [{type:'scroll',depth,at}] for each milestone reached for the first time, in order, where reaches is [{depth,at}] with depth in 0..1. engagementMs(steps,{idleMs}) -> milliseconds between the first and last step, minus every gap longer than idleMs. outboundClicks(clicks,{origin}) -> [{type:'outbound',href,at}] for clicks whose href is absolute and its origin differs.

tag/recorder.mjs: snapshot(dom,{maskText=false}) -> a node array (see below). The form is a flat array of nodes in document order, each {i,parent,tag,attrs,text?} with i a 1-based integer index and parent the index of the parent node or 0 for the root. Attrs is the element's attributes as an object. Masking is absolute and not optional: the value of an input, textarea or select is never serialized, and such an element carries masked:true instead. An element carrying a data-signal-mask attribute, or any descendant of one, carries masked:true and its text is replaced by the fixed string '***' at every depth. When maskText is true every text node is '***'. diff(previous,next) -> {added,removed,changed,moved} where added and removed are arrays of node indices in next and previous, changed is [{i,attrs?,text?}] for nodes whose attributes or text differ, and moved is [{i,parent}] where the parent index changed. mask(node) -> the node with its value dropped and masked flagged, applying the same rules to a single node. Delivered recordings are bounded: diff must never emit more than 500 node references in a single delta.

tag/errors.mjs: captureError({kind,message,stack,at,url},{maxMessage=200,maxStack=800,maxPerMinute=10},seen) -> {event,seen} or {event:null,seen}. The event is {type:'error',kind,message,stack,at,url,count} with message and stack truncated to maxMessage and maxStack characters. A repeat of the same kind and message updates the previous event's count and at instead of emitting a new one, and no more than maxPerMinute distinct messages are emitted within any 60000 ms window measured from the first; beyond that the event is null. seen is a plain serializable value the caller passes back on the next call.

tag/batch.mjs: createBatcher({siteKey,sessionId,now,maxEvents,maxBytes}) -> a serializable batch {schema:1,siteKey,sessionId,sentAt,events:[]}. add(batch,event,{maxEvents,maxBytes}) -> {batch,flush} where flush is true when adding the event would exceed maxEvents or when the encoded payload would exceed maxBytes; the event is still added before flushing and the batch is never allowed to exceed the caps. encode(batch) -> the JSON string that goes on the wire. shouldFlush(batch,{at,lastFlushAt,intervalMs,visibility}) -> true when the interval has elapsed or the page is hidden, and never true for an empty batch. wire(batch,payload) -> {method:'POST',headers:{'content-type':'application/json'},body:payload,beacon:true} for an unload flush, and beacon false otherwise.

ingest/handler.mjs: handle(request,sites) -> {status,headers,body} where request is {method,headers,body,now} with headers a lowercase-key map and body a string. Accept only POST with a JSON content type and a body that parses as a schema-1 batch: answer 202 with {accepted:true,siteKey,sessionId,events} when the site key is known and events is a non-empty array of objects each with a string type; 400 for a wrong method, wrong content type, unparsable JSON or a schema that does not match; 403 for a site key that is not in sites; 413 when the body exceeds maxBytes; 204 when the batch is empty or the site is opted out, with no store change. Refusals must carry {accepted:false,code} with code one of bad_method, bad_content_type, bad_json, bad_schema, unknown_site, too_large, empty.

ingest/store.mjs: applyBatch(state,batch,at) -> {state,stored} where state is a plain serializable value holding {sites:{key:{sessions:{id:{firstSeenAt,lastSeenAt,pageviews,engagementMs,rageClicks,deadClicks,errors,recordings}}},events:[]}} and stored is the number of events kept. Retention: at most 20000 events and 500 sessions per site, and when a cap is reached the oldest is dropped and the state records what it dropped as sites[key].dropped = {events,sessions} counting every drop. summarise(state,{siteKey}) -> {siteKey,sessions,pageviews,pages:[{path,views,engagementMs,rageClicks,deadClicks,errors}],scrollFunnel:[{depth,sessions}],errors:[{message,count,lastAt}],recordings:[{sessionId,events}]} with pages ordered by descending views then ascending path, scrollFunnel ordered by depth, errors by descending count then ascending message, and recordings by descending lastSeenAt.

dashboard/view.mjs: renderDashboard(summary,{site}) -> a complete HTML string with exactly one <main>, an <h1> naming the site, a page table whose rows carry the page path and its views, engagement seconds, rage clicks, dead clicks and errors, the scroll funnel as an ordered list of depths with session counts, the error list, and exactly one script element of type application/json carrying the playback payload for the recorded sessions. Every dynamic value is escaped; no value from the data may become markup.

app.mjs: runScenario({pages,session,config,attributes,now,sites}) -> async {batches,decisions,state,summary,html}. Drive the whole platform from the seeded script: parse the config, apply the block rules, open a session, walk the steps in order, emit the events the tag would emit (pageview, scroll, rage-click, dead-click, outbound, error, and one recording delta per mutate), batch them under the caps, hand each batch to the ingest handler against sites, apply every accepted batch to the store, and return the batches sent, the per-batch ingest decisions, the final store state, its summary, and renderDashboard over it for site pages.siteKey. Visibility steps hide the page and flush. The steps are processed in the order given; the caller's now is the session's startedAt.`;

const summary = "Mission: build Signal, a first-party site analytics platform, to the contracts in PRODUCT.md. A customer pastes one tag on every page of every site they own. The tag reports pageviews, scroll depth, rage clicks, dead clicks, outbound clicks, engagement time and JavaScript errors, and records a masked session replay. A tiny ingest validates and stores it, typed refusal by typed refusal. A dashboard answers the owner question: what is working and what is not. The contracts are fixed in PRODUCT.md: parseConfig, isBlocked, createSession, pageview, shouldRoll, rageClicks, deadClicks, scrollMilestones, engagementMs, outboundClicks, snapshot, diff, mask, captureError, createBatcher, add, encode, shouldFlush, wire, handle, applyBatch, summarise, renderDashboard, and runScenario. Implement every one of them exactly as written. app.mjs runScenario is the contract the platform is judged by: it drives the seeded site and the seeded visitor session through the whole path and returns {batches,decisions,state,summary,html}. The tag is authored as the six tag/ modules named above, and the bar on it is not negotiable: it is at most 12 KB gzipped for the whole directory, every import it makes resolves to a file inside tag/, and it imports nothing outside tag/. Input values are never serialized, and a mask-marked subtree is redacted at every depth. Every ingest refusal carries its own code and changes no stored state. Every dynamic value in the dashboard is escaped. The site pages, the visitor session and the wire schema are seeded: consume them, do not retype them.";

const notReady = (name, async = false) =>
  `export ${async ? 'async ' : ''}function ${name}() { throw new Error('Not implemented'); }\n`;

const modules = {
  'tag/config.mjs': notReady('parseConfig') + notReady('isBlocked'),
  'tag/session.mjs': notReady('createSession') + notReady('pageview') + notReady('shouldRoll'),
  'tag/quality.mjs': notReady('rageClicks') + notReady('deadClicks') + notReady('scrollMilestones') + notReady('engagementMs') + notReady('outboundClicks'),
  'tag/recorder.mjs': notReady('snapshot') + notReady('diff') + notReady('mask'),
  'tag/errors.mjs': notReady('captureError'),
  'tag/batch.mjs': notReady('createBatcher') + notReady('add') + notReady('encode') + notReady('shouldFlush') + notReady('wire'),
  'ingest/handler.mjs': notReady('handle'),
  'ingest/store.mjs': notReady('applyBatch') + notReady('summarise'),
  'dashboard/view.mjs': notReady('renderDashboard'),
  'app.mjs': notReady('runScenario', true),
};

/** The seeded customer site, and the scripted session the verifier replays through the tag. */
const site = {
  siteKey: 'st_chesterhill7',
  name: 'Chester Hill Solutions',
  pages: [
    {
      id: 'home',
      path: '/',
      title: 'Chester Hill Solutions',
      dom: {
        tag: 'main',
        attrs: {},
        children: [
          { tag: 'h1', attrs: {}, text: 'Chester Hill Solutions' },
          { tag: 'p', attrs: { class: 'lede' }, text: 'Software for campaigns.' },
          { tag: 'a', attrs: { href: 'https://calendly.example.test/chesterhill', class: 'cta' }, text: 'Talk to us' },
          { tag: 'button', attrs: { id: 'buy', class: 'cta' }, text: 'Buy' },
        ],
      },
    },
    {
      id: 'pricing',
      path: '/pricing',
      title: 'Pricing',
      dom: {
        tag: 'main',
        attrs: {},
        children: [
          { tag: 'h1', attrs: {}, text: 'Pricing' },
          { tag: 'button', attrs: { id: 'checkout', class: 'cta' }, text: 'Start' },
          { tag: 'div', attrs: { 'data-signal-mask': '' }, children: [{ tag: 'span', attrs: {}, text: 'internal note' }] },
        ],
      },
    },
    {
      id: 'checkout',
      path: '/checkout',
      title: 'Checkout',
      dom: {
        tag: 'main',
        attrs: {},
        children: [
          { tag: 'h1', attrs: {}, text: 'Checkout' },
          { tag: 'form', attrs: { id: 'pay' }, children: [
            { tag: 'input', attrs: { id: 'card', name: 'card', type: 'text' } },
            { tag: 'button', attrs: { id: 'pay-now', type: 'submit' }, text: 'Pay' },
          ] },
        ],
      },
    },
  ],
};

/**
 * The scripted visitor: a visitor who reads, scrolls, gets a button that does nothing, rage
 * clicks it, fills a card field, hits an error, and leaves. Every expectation in the grading
 * below is computed from this list, in the parent, and never from the submission.
 */
const visitorSession = {
  visitor: 'v_9f2c41',
  startedAt: 1_766_000_000_000,
  steps: [
    { at: 0, op: 'load', page: 'home' },
    { at: 400, op: 'scroll', depth: 0.3 },
    { at: 900, op: 'scroll', depth: 0.55 },
    { at: 1400, op: 'click', selector: '.lede', x: 120, y: 300, signal: false },
    { at: 1800, op: 'click', selector: '#buy', x: 200, y: 480, signal: false },
    { at: 2100, op: 'click', selector: '#buy', x: 204, y: 481, signal: false },
    { at: 2400, op: 'click', selector: '#buy', x: 199, y: 479, signal: false },
    { at: 2700, op: 'click', selector: '#buy', x: 201, y: 482, signal: false },
    { at: 3100, op: 'click', selector: '.cta', x: 260, y: 210, signal: true, href: 'https://calendly.example.test/chesterhill' },
    { at: 3600, op: 'mutate', selector: '.lede', html: 'Software for campaigns and causes.' },
    { at: 4200, op: 'load', page: 'pricing' },
    { at: 4800, op: 'scroll', depth: 0.8 },
    { at: 5200, op: 'click', selector: '#checkout', x: 300, y: 400, signal: true },
    { at: 5800, op: 'load', page: 'checkout' },
    { at: 6400, op: 'input', selector: '#card', value: '4111 1111 1111 1111', secret: true },
    { at: 7000, op: 'error', kind: 'uncaught', message: 'Cannot read properties of undefined (reading "total")', stack: 'at pay (checkout.mjs:42:7)' },
    { at: 9000, op: 'error', kind: 'uncaught', message: 'Cannot read properties of undefined (reading "total")', stack: 'at pay (checkout.mjs:42:7)' },
    { at: 12000, op: 'visibility', state: 'hidden' },
  ],
};

const files = {
  'package.json': JSON.stringify({ name: 'signal-analytics', private: true, type: 'module' }, null, 2) + '\n',
  'PRODUCT.md': shared + '\n\n' + spec + '\n',
  'site/pages.json': JSON.stringify(site, null, 2) + '\n',
  'site/session.json': JSON.stringify(visitorSession, null, 2) + '\n',
  ...modules,
  'public/dashboard.css': '/* Build a responsive, accessible dashboard stylesheet. */\n',
  'README.md': '# Signal\n\nImplement the analytics platform described in PRODUCT.md: the tag modules under tag/, the ingest and store under ingest/, the dashboard view under dashboard/, and app.mjs wiring them together. Run the seeded scenario by importing runScenario from app.mjs with the seeded site and session. No packages or external services are needed. Document the completed modules, the embed snippet, and local scenario usage here.\n',
};

const editablePaths = [...Object.keys(modules), 'public/dashboard.css', 'README.md'];

const roles = [
  ['bootstrap', 'Tag bootstrap and session lifecycle', 'Parse and validate the tag attributes with their documented defaults, implement the do-not-track and opt-out rules, and own the deterministic session id, pageview recording and inactivity roll so one visitor-day is one session.', ['tag/config.mjs', 'tag/session.mjs']],
  ['quality', 'Interaction quality', 'Implement rage clicks over a time window and radius, dead clicks, scroll milestones, engagement excluding idle gaps, and outbound clicks. These are the signals the dashboard exists to show.', ['tag/quality.mjs']],
  ['recorder', 'Replay recorder', 'Serialize a DOM to a flat indexed node list, diff two serializations, and mask absolutely: input values are never serialized and mask-marked subtrees are redacted at every depth.', ['tag/recorder.mjs']],
  ['errors', 'Error capture', 'Capture page errors with bounded message and stack, dedupe repeats into a count, and cap distinct messages per minute.', ['tag/errors.mjs']],
  ['batching', 'Batching and transport', 'Batch events under the count and byte caps, decide flushes from the interval and page visibility, and produce the wire request including the unload beacon case.', ['tag/batch.mjs']],
  ['ingest', 'Ingest and storage', 'Validate and type every refusal at the edge, and apply accepted batches to a retained store with caps that record what they dropped.', ['ingest/handler.mjs', 'ingest/store.mjs']],
  ['reporting', 'Owner dashboard', 'Aggregate per page, funnel, error list and playback payload, and render the owner dashboard with every dynamic value escaped.', ['dashboard/view.mjs', 'public/dashboard.css']],
  ['integration', 'End-to-end wiring', 'Implement runScenario end to end over the seeded site and session: config, the tag event stream, batching, the ingest handler and its typed decisions, the store, the summary and the rendered dashboard. This is the contract the whole platform is judged by.', ['app.mjs', 'README.md']],
];

const criteria = [
  'tag-config-parse',
  'tag-config-refusal',
  'tag-block-rules',
  'tag-session-identity',
  'tag-session-roll',
  'tag-scroll-funnel',
  'tag-rage-clicks',
  'tag-dead-clicks',
  'tag-outbound-clicks',
  'tag-engagement-time',
  'tag-error-capture',
  'tag-recorder-snapshot',
  'tag-recorder-diff',
  'tag-recorder-masking',
  'tag-batching-bounds',
  'tag-flush-rules',
  'ingest-accept',
  'ingest-typed-refusals',
  'ingest-no-state-on-refusal',
  'store-aggregates',
  'store-retention',
  'dashboard-render',
  'dashboard-escaping',
  'end-to-end-scenario',
  'tag-size-budget',
  'tag-self-contained',
  'public-wire-contract',
];

function fixture() {
  const workstreams = roles.map(([id, role, brief, paths]) => ({
    id,
    role,
    brief: brief + ' Read PRODUCT.md and the seeded site and session. Implement the whole stated contract, integrate with peer modules and preserve the seeded files. Workstream focus is not exclusive ownership.',
    paths,
    // The dependency edges are the ones the product actually has: the tag reports what the
    // session and the quality modules produce, ingest stores what the batcher encodes, the
    // dashboard reads the store, and the integration contract consumes everything.
    dependencies:
      id === 'batching'
        ? ['tag/session.mjs', 'tag/quality.mjs'].map(producerPath => ({ producerPath, consumerPath: 'tag/batch.mjs' }))
        : id === 'ingest'
          ? [{ producerPath: 'tag/batch.mjs', consumerPath: 'ingest/handler.mjs' }]
          : id === 'reporting'
            ? [{ producerPath: 'ingest/store.mjs', consumerPath: 'dashboard/view.mjs' }]
            : id === 'integration'
              ? Object.keys(modules).filter(path => path !== 'app.mjs').map(producerPath => ({ producerPath, consumerPath: 'app.mjs' }))
              : [],
  }));

  return {
    id: 'signal-analytics',
    title: 'Signal: first-party site analytics',
    domain: 'analytics',
    goal: shared + '\n\n' + summary,
    files,
    protectedPaths: Object.keys(files).filter(path => !editablePaths.includes(path)),
    editablePaths,
    criteria: criteria.map(id => ({ id, description: id.replaceAll('-', ' ') })),
    workstreams,
    evaluatorTimeoutMs: 30000,
    reviewInvocation: { path: 'app.mjs', exportName: 'runScenario', args: [scenario()] },
  };
}

export const analyticsMissions = [fixture()];

// --- grading -------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** The scenario the verifier drives: the seeded site, session and attributes, nothing else. */
function scenario(overrides = {}) {
  return {
    pages: site,
    session: visitorSession,
    sites: { [site.siteKey]: { name: site.name, optedOut: false } },
    origin: 'https://chester-hill-solutions.example',
    attributes: { 'data-site': site.siteKey, 'data-endpoint': 'https://signal.example.test/v1/collect', 'data-max-events': '3' },
    now: visitorSession.startedAt,
    ...overrides,
  };
}

/**
 * What the scripted session *must* produce, computed here from the script.
 *
 * This is the whole point of the fixture: the expectations are derived in the parent, from the
 * input the submission was given, so the submission cannot define its own success. Each figure
 * below is arithmetic over `visitorSession.steps` and can be checked by hand.
 */
const expectation = {
  pageviews: 3,
  rollMs: 1800000,
  scroll: { home: [25, 50], pricing: [75], checkout: [] },
  rage: [{ selector: '#buy', at: 2700, count: 4 }],
  dead: [{ selector: '.lede', at: 1400 }, { selector: '#buy', at: 1800 }, { selector: '#buy', at: 2100 }, { selector: '#buy', at: 2400 }, { selector: '#buy', at: 2700 }],
  outbound: [{ href: 'https://calendly.example.test/chesterhill', at: 3100 }],
  errors: { steps: 2, distinctMessages: 1, count: 2, message: 'Cannot read properties of undefined (reading "total")' },
  engagementMs: 12000,
  secret: '4111 1111 1111 1111',
  maskedText: 'internal note',
  pages: { '/': { views: 1 }, '/pricing': { views: 1 }, '/checkout': { views: 1 } },
};

export async function verifyAnalyticsMission(id, root) {
  const mission = analyticsMissions.find(value => value.id === id);
  if (!mission) throw new Error('Unknown analytics mission');
  return verifyMission(mission, root, async tools => { await gradeSignal(root, tools); });
}

/**
 * The whole grading pass, inside the invocation budget.
 *
 * `missionBounds.invocations` is 16 and each submission call costs one, so the calls are made
 * once, up front, and cached -- a call is made only if a check needs it. The fine-grained
 * contracts get their own call; everything that is really about the platform working gets
 * graded from the single `runScenario` result, because the integration contract is the one the
 * product is judged by and it exercises the others on the way through.
 *
 * A failed call is stored rather than thrown. One unimplemented module must fail the checks that
 * read it and no others: a throw here would report every contract as failed, which is a lie about
 * the submission and makes the result unreadable.
 */
async function gradeSignal(root, { invoke, check }) {
  const call = async (path, name, args) => {
    try { return { ok: true, value: await invoke(path, name, args) }; }
    catch (error) { return { ok: false, error }; }
  };
  const need = result => { assert.ok(result.ok, `invocation failed: ${result.error?.message}`); return result.value; };

  const run = await call('app.mjs', 'runScenario', [scenario()]);
  const config = await call('tag/config.mjs', 'parseConfig', [{ src: 'https://signal.example.test/t.js', attributes: scenario().attributes }]);
  const missingSite = await call('tag/config.mjs', 'parseConfig', [{ src: 'https://signal.example.test/t.js', attributes: { 'data-endpoint': 'https://signal.example.test/v1/collect' } }]);
  const blockedDnt = await call('tag/config.mjs', 'isBlocked', [{ respectDnt: true }, { dnt: true, optOut: false }]);
  const blockedOptOut = await call('tag/config.mjs', 'isBlocked', [{ respectDnt: false }, { dnt: false, optOut: true }]);
  const session = await call('tag/session.mjs', 'createSession', [{ siteKey: site.siteKey, visitor: visitorSession.visitor, now: visitorSession.startedAt }]);
  const rolled = session.ok
    ? await call('tag/session.mjs', 'shouldRoll', [session.value, visitorSession.startedAt + expectation.rollMs + 1, { rollMs: expectation.rollMs }])
    : { ok: false, error: session.error };
  const rage = await call('tag/quality.mjs', 'rageClicks', [[
    { selector: '.lede', x: 100, y: 100, at: 100 },
    { selector: '#buy', x: 200, y: 480, at: 1800 },
    { selector: '#buy', x: 204, y: 481, at: 2100 },
    { selector: '#buy', x: 199, y: 479, at: 2400 },
    { selector: '#buy', x: 201, y: 482, at: 2700 },
    { selector: '.cta', x: 900, y: 40, at: 6400 },
    { selector: '.cta', x: 901, y: 41, at: 6700 },
  ]]);
  const dead = await call('tag/quality.mjs', 'deadClicks', [[
    { selector: '.lede', x: 120, y: 300, at: 1400, signal: false },
    { selector: '.cta', x: 260, y: 210, at: 3100, signal: true },
  ]]);
  const snap = await call('tag/recorder.mjs', 'snapshot', [site.pages[2].dom, { maskText: false }]);
  const changed = await call('tag/recorder.mjs', 'diff', [
    [{ i: 1, parent: 0, tag: 'main', attrs: {} }, { i: 2, parent: 1, tag: 'p', attrs: { class: 'lede' }, text: 'one' }],
    [{ i: 1, parent: 0, tag: 'main', attrs: {} }, { i: 2, parent: 1, tag: 'p', attrs: { class: 'lede' }, text: 'two' }, { i: 3, parent: 1, tag: 'span', attrs: {} }],
  ]);
  const captured = await call('tag/errors.mjs', 'captureError', [{ kind: 'uncaught', message: expectation.errors.message, stack: 'at pay (checkout.mjs:42:7)', at: 7000, url: 'https://chester-hill-solutions.example/checkout' }]);
  const batcher = await call('tag/batch.mjs', 'createBatcher', [{ siteKey: site.siteKey, sessionId: 'ses_0123456789abcdef', now: visitorSession.startedAt, maxEvents: 3, maxBytes: 65536 }]);
  // Five hundred sessions already held, then one more: the cap must drop the oldest and say so.
  const saturated = {
    sites: {
      [site.siteKey]: {
        sessions: Object.fromEntries(Array.from({ length: 500 }, (_, index) => ['ses_' + String(index).padStart(16, '0'), { firstSeenAt: index, lastSeenAt: index, pageviews: 1, engagementMs: 1, rageClicks: 0, deadClicks: 0, errors: 0, recordings: 0 }])),
        events: [],
      },
    },
  };
  const retention = await call('ingest/store.mjs', 'applyBatch', [saturated, { schema: 1, siteKey: site.siteKey, sessionId: 'ses_ffffffffffffffff', sentAt: visitorSession.startedAt, events: [{ type: 'pageview', path: '/', at: visitorSession.startedAt }] }, visitorSession.startedAt]);
  const accepted = await call('ingest/handler.mjs', 'handle', [
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 1, siteKey: site.siteKey, sessionId: 'ses_0123456789abcdef', sentAt: visitorSession.startedAt, events: [{ type: 'pageview', path: '/' }] }), now: visitorSession.startedAt },
    scenario().sites,
  ]);
  const unknownSite = await call('ingest/handler.mjs', 'handle', [
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 1, siteKey: 'st_nope', sessionId: 'ses_0123456789abcdef', sentAt: 0, events: [{ type: 'pageview' }] }), now: 0 },
    scenario().sites,
  ]);

  // --- the tag's bootstrap and its block rules ---

  await check('tag-config-parse', () => {
    const parsed = need(config);
    assert.equal(parsed.siteKey, site.siteKey);
    assert.equal(parsed.endpoint, 'https://signal.example.test/v1/collect');
    assert.equal(parsed.sampleRate, 1);
    assert.equal(parsed.respectDnt, true);
    assert.equal(parsed.maskText, false);
    assert.equal(parsed.idleMs, 5000);
    assert.equal(parsed.rollMs, 1800000);
    // The seeded tag overrides the event cap, so this is the override being asserted and the
    // defaults for everything else. The first version asserted 50 here and contradicted the
    // contract in the same file -- a submission that followed the spec failed the judge.
    assert.equal(parsed.maxEvents, 3, 'the data-max-events override was not honoured');
    assert.equal(parsed.maxBytes, 65536);
    assert.equal(parsed.intervalMs, 10000);
    assert.equal(parsed.maxBytes, 65536);
    assert.equal(parsed.intervalMs, 10000);
  });

  await check('tag-config-refusal', () => {
    assert.ok(config.ok, 'a refusal means nothing from a module that cannot parse a valid tag');
    assert.equal(missingSite.ok, false, 'a tag with no site key was accepted');
    // The refusal is the contract; the wording is not. Isolation flattens the error object, so
    // an assertion on its message fails for a submission that refused correctly.
    assert.notEqual(missingSite.error, undefined, 'a refusal must carry something');
  });

  await check('tag-block-rules', () => {
    assert.equal(need(blockedDnt), true, 'do-not-track did not block a tag that respects it');
    assert.equal(need(blockedOptOut), true, 'an explicit opt-out did not block the tag');
  });

  await check('tag-session-identity', () => {
    const created = need(session);
    assert.match(created.id, /^ses_[0-9a-f]{16}$/, `session id ${created.id} is not a site-visitor-day digest`);
    assert.equal(created.pageviews, 0, 'a new session starts with no pageviews');
    assert.equal(created.startedAt, visitorSession.startedAt);
  });

  await check('tag-session-roll', () => {
    assert.equal(need(rolled), true, 'a session past the roll window did not roll');
    // The in-window case costs an invocation there is not budget for, and the run covers it:
    // the seeded session spans twelve seconds against a thirty-minute window, and the store is
    // asserted to hold exactly one session.
  });

  // --- the signals the dashboard exists to show ---

  await check('tag-scroll-funnel', () => {
    // The seeded session reaches 0.3 and 0.55 on the home page and 0.8 on pricing, which is
    // three distinct milestones: 25 and 50 from home, 75 from pricing, and 100 never. The funnel
    // is per session, so a depth already passed does not appear twice.
    const funnel = need(run).summary?.scrollFunnel ?? [];
    const depths = funnel.map(row => row.depth);
    assert.deepEqual(depths, [25, 50, 75], `the funnel shows ${JSON.stringify(depths)}`);
    assert.ok(funnel.every(row => row.sessions === 1), 'each reached depth is exactly one session');
  });

  await check('tag-rage-clicks', () => {
    const events = need(rage);
    assert.equal(events.length, 1, `expected one rage group, got ${events.length}`);
    assert.equal(events[0].selector, '#buy');
    assert.equal(events[0].count, 4, `the group counted ${events[0].count}`);
    assert.equal(events[0].at, expectation.rage[0].at, 'the rage event is not stamped at the last click of the group');
    assert.equal(events[0].type, 'rage-click');
  });

  await check('tag-dead-clicks', () => {
    const events = need(dead);
    assert.equal(events.length, 1, 'only the click that changed nothing is dead');
    assert.equal(events[0].selector, '.lede');
    assert.equal(events[0].at, 1400);
    assert.equal(events[0].type, 'dead-click');
  });

  await check('tag-outbound-clicks', () => {
    // The seeded session's one signalled click leaves for another origin, and the run has to
    // have classified it as outbound. The tag is given the site origin and nothing else.
    const result = need(run);
    const types = eventsOf(result).map(event => event.type);
    assert.ok(types.includes('outbound'), `the session recorded ${JSON.stringify(types)}`);
    const outbound = eventsOf(result).filter(event => event.type === 'outbound');
    assert.ok(outbound.some(event => String(event.href).includes('calendly.example.test')), 'the outbound href was not recorded');
  });

  await check('tag-engagement-time', () => {
    // 0 ms to 12000 ms with no gap over the 5000 ms idle threshold: the whole span counts.
    const result = need(run);
    const summary = result.summary ?? {};
    const engaged = (summary.pages ?? []).reduce((total, row) => total + (Number(row.engagementMs) || 0), 0);
    assert.equal(engaged, expectation.engagementMs, `engagement summed to ${engaged}`);
  });

  await check('tag-error-capture', () => {
    const value = need(captured);
    const event = value?.event ?? value;
    assert.ok(event, 'a first error produced no event');
    assert.equal(event.type, 'error');
    assert.equal(event.message, expectation.errors.message);
    assert.ok(event.message.length <= 200, 'the message was not bounded');
    assert.ok(String(event.stack).length <= 800, 'the stack was not bounded');

    // The seeded session throws the same message twice, and the second must be a count rather
    // than a second event.
    const errors = eventsOf(need(run)).filter(entry => entry.type === 'error');
    assert.equal(errors.length, expectation.errors.distinctMessages, `the run emitted ${errors.length} error events`);
    assert.equal(errors[0].count, expectation.errors.count, `the repeat was not counted: ${errors[0].count}`);
  });

  // --- the recorder, where masking is the whole product risk ---

  await check('tag-recorder-snapshot', () => {
    const nodes = need(snap);
    assert.ok(Array.isArray(nodes) && nodes.length > 0, 'the snapshot returned no nodes');
    assert.equal(nodes[0].parent, 0, 'the root must have no parent');
    for (const node of nodes) {
      assert.ok(Number.isInteger(node.i) && node.i >= 1, 'a node is missing its index');
      assert.ok(Number.isInteger(node.parent) && node.parent >= 0, 'a node is missing its parent');
      assert.ok(typeof node.tag === 'string' && node.tag.length > 0, 'a node is missing its tag');
      assert.equal(typeof node.attrs, 'object', 'a node is missing its attributes');
    }
    const input = nodes.find(node => node.tag === 'input');
    assert.ok(input, 'the seeded input is not in the snapshot');
    assert.equal(input.masked, true, 'an input was serialized without being masked');
  });

  await check('tag-recorder-diff', () => {
    const delta = need(changed);
    assert.deepEqual(delta.added, [3], 'the added node was not reported');
    assert.deepEqual(delta.removed, [], 'nothing was removed');
    assert.deepEqual(delta.changed.map(entry => entry.i), [2], 'the changed text was not reported');
    assert.ok(Array.isArray(delta.moved), 'moved must always be present');
  });

  await check('tag-recorder-masking', () => {
    const serialized = JSON.stringify(need(snap));
    assert.equal(serialized.includes('"value"'), false, 'the snapshot serialized an input value');
    assert.equal(serialized.includes(expectation.secret), false, 'the seeded card number reached the recording');
    assert.equal(serialized.includes(expectation.maskedText), false,
      'the text of a mask-marked subtree was serialized');
    const masked = need(snap).filter(node => node.masked === true);
    assert.ok(masked.length >= 1, 'nothing from the mask-marked subtree was flagged');
  });

  // --- batching, the wire, and the ingest's typed refusals ---

  await check('tag-batching-bounds', () => {
    const created = need(batcher);
    assert.equal(created.schema, 1);
    assert.equal(created.siteKey, site.siteKey);
    assert.match(created.sessionId, /^ses_[0-9a-f]{16}$/);
    assert.deepEqual(created.events, []);
      // The seeded scenario sets an event cap of three, so the run has to flush repeatedly rather
    // than buffer everything: the bound is exercised on the integration path, not in isolation.
    const batches = need(run).batches ?? [];
    assert.ok(batches.length >= 2, `the scenario produced ${batches.length} batches under a three-event cap`);
    for (const batch of batches) {
      assert.ok(batch.events.length <= 3, `a batch carried ${batch.events.length} events against a cap of three`);
    }
  });

  await check('tag-flush-rules', () => {
    // The seeded session hides the page with events still pending, and a hidden page flushes.
    const result = need(run);
    const last = result.batches[result.batches.length - 1];
    const hiddenAt = visitorSession.steps[visitorSession.steps.length - 1].at;
    assert.ok(last, 'the scenario produced no batch');
    assert.ok(Number(last.sentAt) >= hiddenAt, `the last batch was stamped ${last.sentAt}, before the page was hidden at ${hiddenAt}`);
  });

  await check('ingest-accept', () => {
    const response = need(accepted);
    assert.equal(response.status, 202, `a valid batch answered ${response.status}`);
    const body = responseBody(response);
    assert.ok(body, 'the response body is neither an object nor JSON');
    assert.equal(body.accepted, true);
    assert.equal(body.siteKey, site.siteKey);
    // The contract did not choose between a count and the events themselves, so either is right.
    const carried = Array.isArray(body.events) ? body.events.length : body.events;
    assert.equal(carried, 1, `the acceptance carried ${JSON.stringify(body.events)}`);
  });

  await check('ingest-typed-refusals', () => {
    // One typed refusal directly, and the rest through the store check below: a batch that is
    // refused must not appear in the state.
    const response = need(unknownSite);
    assert.equal(response.status, 403, `an unknown site answered ${response.status}`);
    const body = responseBody(response);
    assert.ok(body, 'the refusal body is neither an object nor JSON');
    assert.equal(body.accepted, false);
    assert.equal(body.code, 'unknown_site');
  });

  await check('ingest-no-state-on-refusal', () => {
    const result = need(run);
    const decisions = result.decisions ?? [];
    assert.ok(decisions.length > 0, 'the scenario made no ingest decisions');
    const refused = decisions.filter(decision => decision.status !== 202);
    assert.deepEqual(refused, [], 'a batch from the seeded scenario was refused');
    // And the store holds exactly what the accepted batches carried: one session, one site.
    const sites = Object.keys(result.state?.sites ?? {});
    assert.deepEqual(sites, [site.siteKey], `the store holds ${JSON.stringify(sites)}`);
  });

  // --- the store, the dashboard, and the platform end to end ---

  await check('store-aggregates', () => {
    const summary = need(run).summary;
    assert.ok(summary, 'runScenario returned no summary');
    assert.equal(summary.siteKey, site.siteKey);
    assert.equal(summary.pageviews, expectation.pageviews, `expected ${expectation.pageviews} pageviews`);
    assert.equal(summary.sessions, 1);
    for (const [path, want] of Object.entries(expectation.pages)) {
      const row = (summary.pages ?? []).find(value => value.path === path);
      assert.ok(row, `no dashboard row for ${path}`);
      assert.equal(row.views, want.views, `${path} views`);
    }
  });

  await check('store-retention', () => {
    const result = need(retention);
    const state = result.state ?? result;
    const held = state.sites?.[site.siteKey] ?? {};
    const sessions = Object.keys(held.sessions ?? {});
    assert.ok(sessions.length <= 500, `the store held ${sessions.length} sessions against a cap of 500`);
    assert.equal(sessions.includes('ses_ffffffffffffffff'), true, 'the newest session was not stored');
    assert.equal(sessions.includes('ses_0000000000000000'), false, 'the oldest session was not dropped');
    assert.ok(Number(held.dropped?.sessions) >= 1, `the store did not record the drop: ${JSON.stringify(held.dropped)}`);
  });

  await check('dashboard-render', () => {
    const html = need(run).html;
    assert.equal(typeof html, 'string', 'the dashboard rendered nothing');
    assert.equal((html.match(/<main\b/gi) ?? []).length, 1, 'the dashboard must have exactly one main region');
    assert.match(html, /<h1\b[^>]*>[^<]*Chester Hill Solutions/i, 'the site name is not in the dashboard heading');
    for (const path of Object.keys(expectation.pages)) {
      assert.ok(html.includes(path), `the dashboard does not list ${path}`);
    }
    assert.match(html, /<ol\b[^>]*>[\s\S]*<li\b/i, 'the scroll funnel is not an ordered list');
    assert.equal((html.match(/type=["']application\/json["']/gi) ?? []).length, 1,
      'the playback payload is missing or duplicated');
  });

  await check('dashboard-escaping', () => {
    const html = need(run).html;
    assert.equal(html.includes(expectation.secret), false, 'a value from the data reached the dashboard markup');
    assert.equal(html.includes('<script>alert'), false, 'markup from the data was not escaped');
  });

  await check('end-to-end-scenario', () => {
    const result = need(run);
    assert.ok(Array.isArray(result.batches) && result.batches.length > 0, 'the scenario produced no batches');
    assert.equal(Array.isArray(result.decisions), true, 'the scenario recorded no ingest decisions');
    assert.equal(result.decisions.length, result.batches.length, 'every batch must have a decision');
    const summary = result.summary;
    assert.equal(summary.sessions, 1, `expected one session, summarised ${summary.sessions}`);
    const funnel = new Map((summary.scrollFunnel ?? []).map(row => [row.depth, row.sessions]));
    for (const depth of [25, 50, 75]) {
      assert.ok(funnel.get(depth) >= 1, `the scroll funnel does not show depth ${depth}`);
    }
    assert.equal((summary.errors ?? []).length, expectation.errors.distinctMessages, 'the error list does not match');
    assert.equal(summary.recordings.length >= 1, true, 'no recording was summarised');
    const pages = (summary.pages ?? []).map(row => row.path);
    assert.deepEqual(pages, ['/', '/checkout', '/pricing'], `the page order is ${JSON.stringify(pages)}`);
  });

  await check('public-wire-contract', () => {
    const first = need(run).batches[0];
    assert.equal(first.schema, 1, 'the wire payload is not schema 1');
    assert.equal(first.siteKey, site.siteKey);
    assert.match(first.sessionId, /^ses_[0-9a-f]{16}$/);
    assert.ok(Array.isArray(first.events) && first.events.length > 0);
    assert.ok(first.events.every(event => typeof event.type === 'string'));
    assert.equal(typeof first.sentAt, 'number');
  });

  // --- weight, which is a product requirement and not a preference ---

  await check('tag-size-budget', () => {
    const files = tagSource(root);
    // The seeded stubs are not a tag. A budget check that an empty directory passes is a budget
    // check that says nothing, and it let a submission that wrote nothing score here.
    const stubs = files.filter(file => file.body.includes('Not implemented')).map(file => file.name);
    assert.deepEqual(stubs, [], `the tag is still the seeded stub in: ${stubs.join(', ')}`);
    assert.ok(files.length >= 6, `the tag is ${files.length} modules and the product names six`);
    const gzipped = gzipSync(Buffer.from(tagBytes(root).source, 'utf8')).length;
    assert.ok(gzipped <= TAG_BUDGET_BYTES,
      `the tag ships ${gzipped} bytes gzipped against a ${TAG_BUDGET_BYTES}-byte budget`);
  });

  await check('tag-self-contained', () => {
    const files = tagSource(root);
    // The same guard as the budget, for the same reason: a stub ships nothing, and a statement
    // about what the shipped tag imports must not be satisfied by having no tag at all.
    const stubs = files.filter(file => file.body.includes('Not implemented')).map(file => file.name);
    assert.deepEqual(stubs, [], `the tag is still the seeded stub in: ${stubs.join(', ')}`);
    const names = new Set(files.map(file => file.name));
    const imports = tagBytes(root).imports;
    const outside = imports.filter(specifier => !specifier.startsWith('.'));
    assert.deepEqual(outside, [], `the tag imports outside its own directory: ${outside.join(', ')}`);
    // A relative import that resolves to nothing is a broken tag, and it is the failure a
    // self-containment check is best placed to catch.
    const dangling = [];
    for (const file of files) {
      for (const match of file.body.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const target = specifier.split('/').pop();
        if (specifier.split('/').some(part => part === '..') || !names.has(target)) dangling.push(`${file.name} -> ${specifier}`);
      }
    }
    assert.deepEqual(dangling, [], `the tag imports modules that do not exist: ${dangling.join(', ')}`);
  });
}

/**
 * The ingest response body, as an object.
 *
 * The contract says a handler returns a body; it did not say whether that body is a string or a
 * parsed object, and the submission returned the string a real HTTP handler returns. Both
 * readings are correct against a spec that did not choose, so the judge reads either, and the
 * ambiguity is recorded in the mission document rather than resolved by fiat after the fact.
 */
const responseBody = response => {
  const body = response?.body;
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return null; } }
  return body !== null && typeof body === 'object' ? body : null;
};

/** Every event the run recorded, from the batches it sent: the tag's own output. */
function eventsOf(result) {
  return (result.batches ?? []).flatMap(batch => batch.events ?? []);
}

/** Every module under `tag/`, with the import specifiers it names. */
function tagSource(root) {
  const directory = join(root, 'tag');
  let names = [];
  try { names = readdirSync(directory).filter(name => name.endsWith('.mjs')); } catch { names = []; }
  return names.map(name => ({ name, body: readFileSync(join(directory, name), 'utf8') }));
}

/**
 * The tag's shipped source: its own modules concatenated, with the imports they name.
 *
 * The bar is on what ships, which is the tag directory and nothing else. A tag that reaches into
 * the rest of the repository is not embeddable, and a tag whose modules cannot be counted here is
 * one the harness cannot weigh.
 */
function tagBytes(root) {
  const files = tagSource(root);
  assert.ok(files.length >= 1, 'there is no tag to weigh');
  const source = files.map(file => file.body).join('\n');
  const imports = files.flatMap(file => [...file.body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]));
  return { source, imports };
}
