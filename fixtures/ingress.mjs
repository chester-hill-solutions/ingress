import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const ingressSpec=`# Canada: Crossroads

Ingress is the collaborating squad name. Build Canada: Crossroads, a playful Canadian history exploration game, with Node built-ins, ES modules and browser APIs only. Use native file tools; the harness executes and verifies. No dependencies, remote assets, services or credentials. Files are preferred focus, not claims: cross-module edits are allowed when needed. Inspect live peer contracts.

## Canonical content

data/history.json contains twelve root-researched events {id,title,year,era,region,question,options:[{id,text}],correctOptionID,explanation,source:{title,url},x,y}. Preserve id/year/era/question/options/correctOptionID/explanation/source exactly. Content specialist may polish only title/region/x/y and standalone introduction. Eras: early-contact, confederation, modern. Do not invent facts or citations. Coordinates 0..100 are illustrative, not surveyed borders. Vimy Ridge is overseas: its x94/y12 marker belongs in a clearly labelled France inset, not in Canada. Indigenous histories precede the earliest selected event, around1000; the twelve events are not exhaustive. Official sources appear after answers.

## Engine

engine.mjs exports createGame({events,seed=1}={}) -> {snapshot(),chooseEra(era),answer(eventID,optionID),restart(),subscribe(fn)}. subscribe returns unsubscribe. Default era early-contact; sort selected events by year then id, no shuffle. Seed is reserved for reproducibility. Do not mutate supplied data. Reject duplicate event/option IDs and missing correct option relationships during construction. Reject unknown eras, invalid options, repeated answers and answers for non-current events atomically.

snapshot deep-clones {phase:'playing'|'complete',era,score,streak,answered:[{eventID,optionID,correct}],currentEvent,feedback:null|{eventID,correct,explanation,source},progress:{answered,total},milestones:[{id,title,unlocked}],mapEvents:[publicEvent],revision}. Initial revision/score/streak=0, answered=[], feedback=null. Public events exclude correctOptionID AND explanation; mapEvents includes the selected era, currentEvent is next unanswered or null on completion. Only feedback after an answer can expose that event's explanation. Sources must remain official provided source links.

Correct answer earns 10+min(previousStreak,3)*2, increments streak; wrong earns0 and resets streak0. Record once, immediately advance currentEvent, retaining last-answer feedback beside the next question. Complete after all era events; empty eras are complete with zero progress. chooseEra resets score/streak/answers/feedback/milestones; restart resets same era. Every successful mutation increments revision, returns the new snapshot and synchronously notifies subscribers with fresh snapshots. Unsubscribe stops notifications. Rejected operations change nothing.

Milestones EXACT: first-steps ('First Steps') unlocked when answered>=1 even if wrong; streak-three ('Sharp Eye') latches once streak reaches3 until reset; chapter-complete ('Chapter Complete') unlocked on complete.

## HTTP/SSE

server.mjs exports async createGameServer({events,host='127.0.0.1',port=0}={}) -> {url,close}. Omitted events load data/history.json relative to server.mjs (JSON array, or events array in an envelope). Only loopback bind hosts127.0.0.1/::1/localhost. close asynchronously releases SSE/listener and is idempotent. Direct node server.mjs starts, prints URL and handles SIGINT/SIGTERM cleanup.

GET / serves public/index.html; GET /state snapshot JSON; GET /events text/event-stream initialsnapshot then subscribed snapshots with disconnect cleanup. POST /answer {eventID,optionID}; POST /era {era}; POST /restart. All successful POST responses are new snapshots. JSON bodies bounded64KiB. Invalid inputs HTTP400 shortJSONerror/no stacks; unknownpaths404. Raw /data/history.json and all answer-key routes404. Omitted Origin allowed; an Origin must match THIS server's own loopback origin, otherwise403. Never wildcard CORS. Initial/state/map/SSE public data must exclude correctOptionID/explanation; post-answer feedback alone exposes explanation.

## Browser

A playful, richly illustrated paper/ink/red/copper journey, not an admin panel. Stylized Canada SVG terrain/water, region markers and labelled overseas Vimy France inset, chronological timeline, three-era selector, question/choice cards, score/streak/progress, milestone badges, prominent last-answer feedback plus officialsource link beside nextcurrent question, finalchapter/restart flow. Map positions explicitly illustrative. Use EventSource('/events') plus initial GET/state; post documented actions. Show truthful connection/loading/errors. Keyboard-accessible buttons/focus, responsive mobile. Safe DOM textContent for dynamic strings. Do not fetch rawhistory or embed answerkeys. A local Next feedback-dismissal button may toggle presentation, but server already advanced currentEvent. Show nuanced sample intro and sources without inventing history.

README: npm start, printed loopback URL, gameplay/API and sample/illustrative-map limitations. Independent verification stays outside this project. Seed functions are intentionally unfinished; real specialists implement them.
`;
const shared='Read MISSION.md and canonical data/history.json. Work concurrently with the Ingress squad in this SAME workspace using native file tools only. Inspect current peer edits/contracts. Listed files are preferred focus, not ownership claims; cross-module edits are allowed when needed. Keep exports stable. ';
export const ingressTasks=[
 {id:'content',files:['data/history.json','README.md'],dependencies:[],task:shared+'Polish event title/region/x/y and standalone introduction ONLY, preserving immutable id/year/era/question/options/correctOptionID/explanation/source EXACTLY. Coordinate pedagogical region/timeline vocabulary with UI. Vimy belongs in a France inset. Do not invent facts or sources. Indigenous histories precede the first selected event; the twelve events are not exhaustive.'},
 {id:'engine',files:['engine.mjs'],dependencies:[{producerPath:'data/history.json',consumerPath:'engine.mjs'}],task:shared+'Implement createGame completely: chronological eras, strict answer validation/progression, score/streak, exact milestone rules, cloned public snapshots without answer-key leakage, subscriptions, chooseEra/reset/restart. Correct answers remain internal. Follow MISSION.md exactly.'},
 {id:'server',files:['server.mjs','README.md'],dependencies:[{producerPath:'data/history.json',consumerPath:'server.mjs'},{producerPath:'engine.mjs',consumerPath:'server.mjs'}],task:shared+'Implement createGameServer Node HTTP/SSE, game routes, bounded safe JSON, own-loopback Origin checks, raw-data404, SSE disconnect/idempotent close and direct npm start. Load canonical data server-side only. Inspect evolving engine API and update accurate README run/routes.'},
 {id:'ui',files:['public/index.html'],dependencies:[{producerPath:'data/history.json',consumerPath:'public/index.html'},{producerPath:'engine.mjs',consumerPath:'public/index.html'},{producerPath:'server.mjs',consumerPath:'public/index.html'}],task:shared+'Build the polished playful Canada: Crossroads browser game, paper/ink/red/copper aesthetic with illustrated Canada SVG terrain/water, region markers and overseas France/Vimy inset, timeline, accessible choice cards, scoreboard/progress/milestones, prominent source-linked feedback and nextquestion, complete/restart flow. Use SSE, safe DOM rendering, keyboard/mobile/loading/error states. Never fetch/embed raw answerkeys. Inspect actual live server/engine contracts.'},
];
export const ingressIntegrationTask=shared+'Integrate Canada: Crossroads by inspecting final data/engine/server/browser and repairing concrete cross-module mistakes. Preserve immutable researched data and distinctive playful UI. Make npm start and complete era gameplay match MISSION.md; prevent public answer-key leaks and verify source-linked feedback. Update truthful README. Use file tools only; harness executes independent checks. Specialist completion is not proof of correctness.';
const seedFiles={
 'package.json':JSON.stringify({name:'canada-crossroads',version:'0.0.0',private:true,type:'module',scripts:{start:'node server.mjs'}},null,2)+'\n',
 'engine.mjs':`export function createGame({events,seed=1}={}) {
 const pending=()=>{throw new Error('TODO: game engine specialist');};
 return {snapshot:pending,chooseEra:pending,answer:pending,restart:pending,subscribe:pending};
}\n`,
 'server.mjs':`import {createGame} from './engine.mjs';
import {pathToFileURL} from 'node:url';
export async function createGameServer({events,host='127.0.0.1',port=0}={}) {throw new Error('TODO: game HTTP/SSE specialist');}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=await createGameServer();console.log('Canada: Crossroads listening on '+server.url);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();});
}\n`,
 'public/index.html':`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canada: Crossroads</title><style>body{margin:0;background:#f5efe4;color:#153b35;font:16px system-ui;padding:3rem}h1{font:700 clamp(2rem,7vw,5rem) Georgia,serif}small{color:#a72a35}</style><main><small>GANGCODE PRESENTS</small><h1>Canada: Crossroads</h1><p>The browser specialist is building a journey through selected Canadian history.</p><p>Indigenous histories precede the earliest selected event. This selection is not exhaustive; map coordinates are illustrative.</p></main></html>\n`,
 'README.md':'# Canada: Crossroads\n\nA Canadian history game built by the Ingress squad. After implementation, run `npm start` and open its printed loopback URL. See MISSION.md.\n\nIndigenous histories precede the earliest selected event. These twelve events are not exhaustive; the stylized map is illustrative. Official sources appear with answer feedback.\n',
 'MISSION.md':ingressSpec,
};
export async function seedIngress(root,{historyPath=new URL('./canadian-history.json',import.meta.url)}={}) {
 const content=await readFile(historyPath,'utf8'),parsed=JSON.parse(content),events=Array.isArray(parsed)?parsed:parsed.events;
 if(!Array.isArray(events)||events.length===0)throw new Error('Canonical Canadian history data unavailable');
 await mkdir(join(root,'public'),{recursive:true});await mkdir(join(root,'data'),{recursive:true});
 const files={...seedFiles,'data/history.json':content};
 for(const[path,value]of Object.entries(files))await writeFile(join(root,path),value,{flag:'wx'});
 return {paths:Object.keys(files),tasks:structuredClone(ingressTasks),integrationTask:ingressIntegrationTask,dependencies:ingressTasks.flatMap(task=>structuredClone(task.dependencies))};
}
