import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { benchmarkFixtures, verifyBenchmark } from '../fixtures/benchmarks.mjs';

// Reference implementations stay outside agent workspaces and are never exported by fixtures.
const references={
  money:{
    'currency.mjs': `export function lineTotal(product,quantity){if(!Number.isFinite(product.price)||product.price<0||!Number.isSafeInteger(quantity)||quantity<0)throw new RangeError();const total=Math.round(product.price*100)*quantity;if(!Number.isSafeInteger(total))throw new RangeError();return total;}`,
    'checkout.mjs': `import {lineTotal} from './currency.mjs';export function quote(lines,couponCents=0){if(!Number.isSafeInteger(couponCents)||couponCents<0)throw new RangeError();const subtotalCents=lines.reduce((n,l)=>n+lineTotal(l,l.quantity),0);if(!Number.isSafeInteger(subtotalCents))throw new RangeError();return {subtotalCents,totalCents:Math.max(0,subtotalCents-couponCents),currency:'USD'};}`,
  },
  'shared-features':{
    'board.mjs': `export function filterTasks(tasks,{status=null,query=''}={}){if(status!==null&&!['todo','doing','done'].includes(status))throw new RangeError();query=query.trim().toLowerCase();return tasks.filter(t=>(status===null||t.status===status)&&t.title.toLowerCase().includes(query)).map(t=>({...t}));}export function summarizeTasks(tasks){return tasks.reduce((r,t)=>{r.total++;r[t.status]++;if(t.priority==='high')r.urgent++;return r},{total:0,todo:0,doing:0,done:0,urgent:0});}`,
  },
  'dependency-refactor':{
    'labels.mjs': `export function normalizeLabel(label){if(typeof label!=='string')throw new TypeError();const result=label.trim().normalize('NFKD').replace(/\\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');if(!result)throw new TypeError();return result;}`,
    'slug.mjs': `import {normalizeLabel} from './labels.mjs';export {normalizeLabel};export function buildLink(label,locale='en'){if(!['en','fr'].includes(locale))throw new RangeError();return '/'+locale+'/'+normalizeLabel(label);}`,
    'routes.mjs': `import {buildLink} from './slug.mjs';export function routeFor(product,locale='en'){return {href:buildLink(product.title,locale),label:product.title};}`,
  },
  'cache-ttl':{
    'cache.mjs': `export function createCache({clock=Date.now}={}){const map=new Map();function prune(){for(const[k,e]of map)if(clock()>=e.expires)map.delete(k);}return {set(k,v,ttl){if(!Number.isFinite(ttl)||ttl<0)throw new RangeError();map.set(k,{value:v,expires:clock()+ttl});},get(k){prune();return map.get(k)?.value;},has(k){prune();return map.has(k);},delete:k=>map.delete(k),size(){prune();return map.size;}};}`,
    'lookup.mjs': `export function createLookup({load,cache,ttlMs=50}){const pending=new Map();return {get(key){if(cache.has(key))return Promise.resolve(cache.get(key));if(pending.has(key))return pending.get(key);const promise=Promise.resolve().then(()=>load(key)).then(value=>{cache.set(key,value,ttlMs);return value;}).finally(()=>pending.delete(key));pending.set(key,promise);return promise;},clear:key=>cache.delete(key)};}`,
  },
  'strict-format':{
    'parse.mjs': `export function parseRows(text){if(typeof text!=='string')throw new TypeError();const rows=text.replace(/\\r\\n/g,'\\n').split('\\n');if(rows.at(-1)==='')rows.pop();if(rows.shift()!=='name,amount')throw new TypeError();return rows.map(row=>{const fields=row.split(',');if(fields.length!==2)throw new TypeError();const name=fields[0].trim(),amount=fields[1].trim();if(!name||/[|\\r\\n]/.test(name))throw new TypeError();if(!/^(0|[1-9]\\d*)(\\.\\d{1,2})?$/.test(amount))throw new RangeError();const [whole,fraction='']=amount.split('.');const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(cents))throw new RangeError();return {name,cents};});}`,
    'report.mjs': `import {parseRows} from './parse.mjs';const format=cents=>Math.floor(cents/100)+'.'+String(cents%100).padStart(2,'0');export function formatReport(rows){let total=0,result='NAME | CAD\\n';for(const row of rows){if(typeof row.name!=='string'||!row.name||row.name!==row.name.trim()||/[|\\r\\n]/.test(row.name))throw new TypeError();if(!Number.isSafeInteger(row.cents)||row.cents<0)throw new RangeError();total+=row.cents;if(!Number.isSafeInteger(total))throw new RangeError();result+=row.name+' | $'+format(row.cents)+'\\n';}return result+'TOTAL | $'+format(total)+'\\n';}export const formatCSV=text=>formatReport(parseRows(text));`,
  },
  'human-priority':{
    'alerts.mjs': `export function rankAlerts(alerts){const priority={critical:0,warning:1,info:2};for(const a of alerts)if(!Object.hasOwn(priority,a.severity)||typeof a.id!=='string'||!a.id)throw new TypeError();return alerts.map(a=>({...a})).sort((a,b)=>priority[a.severity]-priority[b.severity]||(a.id<b.id?-1:a.id>b.id?1:0));}`,
    'brief.mjs': `import {rankAlerts} from './alerts.mjs';export function buildBrief(alerts){return {title:'Incident brief',items:rankAlerts(alerts),needsAction:alerts.some(a=>a.severity==='critical')};}`,
  },
};
async function seed(fixture,files=fixture.files){const root=await mkdtemp(join(tmpdir(),'gangcode-benchmark-test-'));for(const[path,text]of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text);}return root;}

test('six complete bounded two-agent fixture contracts have editable dependency seams without ownership',()=>{
  assert.equal(benchmarkFixtures.length,6);assert.equal(new Set(benchmarkFixtures.map(f=>f.id)).size,6);
  for(const f of benchmarkFixtures){assert.equal(f.tasks.length,2);assert.ok(f.protectedPaths.includes('package.json'));assert.ok(f.tasks.every(t=>t.text.length>200&&Buffer.byteLength(t.text)<=4096));assert.ok(f.criteria.length>=4);for(const t of f.tasks)for(const e of t.dependencies){assert.ok(Object.hasOwn(f.files,e.producerPath));assert.ok(Object.hasOwn(f.files,e.consumerPath));}assert.ok(f.editablePaths.every(path=>!f.protectedPaths.includes(path)));assert.equal(Object.keys(f).includes('solution'),false);}
});
for(const fixture of benchmarkFixtures){
  test(`${fixture.id}: seeded unfinished project fails independently`,async()=>{const root=await seed(fixture);try{const result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,false);assert.ok(result.checks.some(check=>!check.passed));assert.ok(result.instructionChecks.every(check=>check.passed));assert.deepEqual(result.checks.map(c=>c.name),fixture.criteria.map(c=>c.id));}finally{await rm(root,{recursive:true,force:true});}});
  test(`${fixture.id}: independent reference output passes every functional and integrity criterion`,async()=>{const root=await seed(fixture,{...fixture.files,...references[fixture.id]});try{await writeFile(join(root,'TEAM.md'),'Parent-owned common task instructions');await mkdir(join(root,'.opencode/plugins'),{recursive:true});await writeFile(join(root,'.opencode/plugins/instrumentation.mjs'),'// parent instrumentation');const result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,true,JSON.stringify(result));assert.ok(result.checks.every(check=>check.passed));assert.ok(result.instructionChecks.every(check=>check.passed));}finally{await rm(root,{recursive:true,force:true});}});
}

test('protected file or manifest sabotage fails even with functionally correct implementations',async()=>{
  const fixture=benchmarkFixtures.find(f=>f.id==='human-priority');
  for(const path of ['HUMAN.md','notes.txt','package.json']){const root=await seed(fixture,{...fixture.files,...references[fixture.id]});try{await writeFile(join(root,path),path==='package.json'?'{"type":"module","scripts":{"hide":"true"}}':'Changed bytes');const result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,false);assert.equal(result.instructionChecks.find(c=>c.name===`protected:${path}`).passed,false);}finally{await rm(root,{recursive:true,force:true});}}
});

test('correct-looking output with violated human priority is rejected by hidden behavioral checks',async()=>{
  const fixture=benchmarkFixtures.find(f=>f.id==='human-priority');const root=await seed(fixture,{...fixture.files,...references[fixture.id],'brief.mjs':"import {rankAlerts} from './alerts.mjs';export const buildBrief=alerts=>({title:'Incident brief',items:rankAlerts(alerts),needsAction:false});"});
  try{const result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,false);assert.equal(result.checks.find(c=>c.name==='brief_authority').passed,false);assert.ok(result.instructionChecks.every(c=>c.passed));}finally{await rm(root,{recursive:true,force:true});}
});

test('verifier rejects external/symlink source files and does not expose child prose or credentials',async()=>{
  const fixture=benchmarkFixtures[0],root=await seed(fixture,{...fixture.files,...references.money});
  try{await rm(join(root,'currency.mjs'));await symlink('/etc/passwd',join(root,'currency.mjs'));let result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,false);assert.equal(result.instructionChecks.at(-1).passed,false);
    await rm(join(root,'currency.mjs'));await writeFile(join(root,'currency.mjs'),"console.log('PRIVATE GENERATED PROSE');export const lineTotal=()=>0;");result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(await readFile(join(root,'catalog.json'),'utf8'),fixture.files['catalog.json']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('unknown fixture is explicitly rejected rather than silently reported as a tested failure',async()=>{await assert.rejects(verifyBenchmark('unknown',tmpdir()),/unknown_benchmark_fixture/);});


test('verifier child receives no ambient secrets and cannot write protected workspace data',async()=>{
  const fixture=benchmarkFixtures[0],root=await seed(fixture,{...fixture.files,...references.money});
  const prior=process.env.GANGCODE_VERIFIER_TEST_SECRET;process.env.GANGCODE_VERIFIER_TEST_SECRET='SYNTHETIC_NOT_A_CREDENTIAL';
  try{await writeFile(join(root,'currency.mjs'),"if(process.env.GANGCODE_VERIFIER_TEST_SECRET)throw Error('ambient_environment_leaked');"+references.money['currency.mjs']);assert.equal((await verifyBenchmark(fixture.id,root)).correct,true);
    await writeFile(join(root,'currency.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('catalog.json','tampered');"+references.money['currency.mjs']);const result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,false);assert.ok(result.instructionChecks.every(c=>c.passed));assert.equal(await readFile(join(root,'catalog.json'),'utf8'),fixture.files['catalog.json']);assert.equal(JSON.stringify(result).includes('SYNTHETIC'),false);
  }finally{if(prior===undefined)delete process.env.GANGCODE_VERIFIER_TEST_SECRET;else process.env.GANGCODE_VERIFIER_TEST_SECRET=prior;await rm(root,{recursive:true,force:true});}
});

test('nonterminating generated module is bounded and a missing workspace preserves failed checks',async()=>{
  const fixture=benchmarkFixtures[0],root=await seed(fixture,{...fixture.files,...references.money});
  try{await writeFile(join(root,'currency.mjs'),'while(true){}');const started=Date.now(),result=await verifyBenchmark(fixture.id,root);assert.equal(result.correct,false);assert.ok(result.checks.every(c=>!c.passed));assert.ok(Date.now()-started<6_000);}finally{await rm(root,{recursive:true,force:true});}
  const missing=await verifyBenchmark(fixture.id,root);assert.equal(missing.correct,false);assert.ok(missing.checks.every(c=>!c.passed));assert.ok(missing.instructionChecks.every(c=>!c.passed));
});
