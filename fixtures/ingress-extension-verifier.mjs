import { spawn } from 'node:child_process';
import { verifyIngress } from './ingress-verifier.mjs';

// Independent assertions stay outside the builders' workspace.
const worker = String.raw`
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root=process.argv[1],checks=[],modules={};
async function check(name,fn){try{await fn();checks.push({name,passed:true});}catch{checks.push({name,passed:false});}}
const names={atlas:['projectMarker','mountAtlas'],timeline:['orderedEvents','mountTimeline'],cards:['mountQuestionCard'],scoreboard:['formatScore','mountScoreboard'],badges:['unlockedMilestones','mountBadges'],sound:['createSoundscape','mountSoundToggle'],a11y:['createAccessibility'],progress:['createProgressStore','mountProgress'],glossary:['glossaryEntries','mountGlossary'],itinerary:['itineraryFor','mountItinerary'],notebook:['createNotebook','mountNotebook'],help:['mountKeyboardHelp'],achievements:['milestoneDetails','mountAchievementDetails'],'era-intro':['eraIntroduction','mountEraIntro']};
for(const [name,exports]of Object.entries(names))await check('extension-exports-'+name,async()=>{const value=await import(pathToFileURL(root+'/public/'+name+'.mjs'));for(const key of exports)assert.equal(typeof value[key],'function');modules[name]=value;});
await check('extension-coordinate-clamping',()=>{assert.deepEqual(modules.atlas.projectMarker({x:-10,y:150,region:'France'}),{x:0,y:100,overseas:true});assert.deepEqual(modules.atlas.projectMarker({}),{x:50,y:50,overseas:false});});
await check('extension-timeline-isolation',()=>{const input=[{id:'b',year:1900,nested:{x:1}},{id:'a',year:1800}];const result=modules.timeline.orderedEvents(input);assert.deepEqual(result.map(x=>x.id),['a','b']);result[1].nested.x=8;assert.equal(input[0].nested.x,1);});
await check('extension-score-format',()=>{assert.deepEqual(modules.scoreboard.formatScore({score:22,streak:2,progress:{answered:2,total:4}}),{score:22,streak:2,progressLabel:'2 / 4'});assert.equal(modules.scoreboard.formatScore({score:NaN}).score,0);});
await check('extension-earned-badges-only',()=>{assert.deepEqual(modules.badges.unlockedMilestones({milestones:[{id:'a',unlocked:true},{id:'b',unlocked:false},{id:'c',unlocked:'yes'}]}),['a']);});
await check('extension-sound-lazy',()=>{let created=0;const sound=modules.sound.createSoundscape({audioContextFactory:()=>{created++;throw Error('unavailable');}});sound.play(true);assert.equal(created,0);sound.setEnabled(true);assert.equal(created,0);sound.play(true);assert.equal(created,1);sound.destroy();});
await check('extension-progress-best-score',()=>{const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};const store=modules.progress.createProgressStore(storage);store.write({era:'modern',score:22,progress:{answered:2,total:4}});store.write({era:'modern',score:10,progress:{answered:3,total:4}});assert.deepEqual(store.read(),{version:1,eras:{modern:{score:22,answered:2,total:4}}});store.clear();assert.deepEqual(store.read(),{version:1,eras:{}});values.set('canada-crossroads-progress-v1','bad json');assert.deepEqual(store.read(),{version:1,eras:{}});});
await check('extension-glossary-clones',()=>{const entries=modules.glossary.glossaryEntries();assert.deepEqual(entries.map(x=>x.term),['Era','Streak','Milestone','Source']);entries[0].definition='changed';assert.notEqual(modules.glossary.glossaryEntries()[0].definition,'changed');});
await check('extension-itinerary-evidence',()=>{const result=modules.itinerary.itineraryFor({mapEvents:[{id:'b',title:'B',year:1900},{id:'a',title:'A',year:1800}],answered:[{eventID:'a'}],currentEvent:{id:'b'}});assert.deepEqual(result,[{id:'a',title:'A',year:1800,visited:true,current:false},{id:'b',title:'B',year:1900,visited:false,current:true}]);});
await check('extension-notebook-isolation',()=>{const notes=modules.notebook.createNotebook();notes.record({feedback:null});assert.deepEqual(notes.entries(),[]);const feedback={eventID:'a',correct:false,explanation:'Recorded only',source:{title:'Source',url:'https://example.org/'}};notes.record({feedback});feedback.explanation='changed';notes.record({feedback:{...feedback}});assert.equal(notes.entries().length,1);const out=notes.entries();out[0].source.title='changed';assert.equal(notes.entries()[0].source.title,'Source');notes.clear();assert.deepEqual(notes.entries(),[]);});
await check('extension-achievement-evidence',()=>{const result=modules.achievements.milestoneDetails({milestones:[{id:'first-steps',title:'First Steps',unlocked:false}]});assert.equal(result[0].unlocked,false);assert.ok(result[0].description.length>0);});
await check('extension-era-introductions',()=>{assert.equal(modules['era-intro'].eraIntroduction('modern').title,'Modern Canada');assert.equal(modules['era-intro'].eraIntroduction('missing').title,'Explore');});
await check('extension-ui-references',async()=>{const html=await readFile(root+'/public/index.html','utf8');for(const name of Object.keys(names))assert.ok(html.includes(name+'.mjs')||html.includes("'"+name+"'")||html.includes('"'+name+'"'));});
let server;
await check('extension-http-modules',async()=>{const {createGameServer}=await import(pathToFileURL(root+'/server.mjs'));server=await createGameServer();for(const name of Object.keys(names)){const response=await fetch(new URL('/public/'+name+'.mjs',server.url));assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);await response.body.cancel();}});
await server?.close();
console.log(JSON.stringify({checks}));
`;

async function verifyModules(root) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, root], { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', bytes = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 15_000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) { failed = true; child.kill('SIGKILL'); } else output += chunk; });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (failed || code !== 0 || !Array.isArray(result.checks) || result.checks.length !== 27 || result.checks.some(c => !/^extension-[a-z0-9-]+$/.test(c.name) || typeof c.passed !== 'boolean')) throw Error();
        resolve(result.checks);
      } catch { resolve([{ name: 'extension-verifier-execution', passed: false }]); }
    });
  });
}

export async function verifyIngressExtensions(root) {
  const base = await verifyIngress(root);
  const checks = [...base.checks, ...await verifyModules(root)];
  return { correct: checks.every(check => check.passed), checks };
}
