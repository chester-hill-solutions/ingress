import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startOpenCode, scopedEnvironment } from '../src/process.mjs';

async function fixture(t, behavior='normal') {
  const root=await mkdtemp(join(tmpdir(),'collaboration-process-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'workspace'),binary=join(root,'fake-opencode'),calls=join(root,'calls.jsonl');await mkdir(directory);
  await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),pid:process.pid,cwd:process.cwd(),home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,cache:process.env.XDG_CACHE_HOME,key:process.env.OPENCODE_API_KEY==='explicit-fixture-key',ambient:process.env.OPENCODE_CONFIG,otel:process.env.OTEL_EXPORTER_OTLP_ENDPOINT})+'\\n');
if(process.argv.includes('--pure')){console.error('Unsupported server flag');process.exit(2);}
if(process.argv.includes('--version')){${behavior==='slow'?'setTimeout(()=>console.log("opencode v2.0.16"),100);':behavior==='bad'?'console.log("PRIVATE bad version");':'console.log("opencode v2.0.16");'} }
else{${behavior==='malformed'?'console.log("PRIVATE malformed readiness");process.exit(1);':`console.log('server listening on http://127.0.0.1:12345');console.log('server password fixture-password');setInterval(()=>{},1000);`} }
`,{mode:0o700});
  return {root,binary,directory,calls,stateDir:join(root,'state')};
}

test('scoped environment excludes routing and ambient credentials without changing parent',()=>{
  const ambient={PATH:'/bin',LANG:'en_CA.UTF-8',https_proxy:'http://127.0.0.1:9999',NODE_EXTRA_CA_CERTS:'/fixture/ca.pem',OPENCODE_API_KEY:'ambient-key',OPENCODE_CONFIG:'bad',OTEL_EXPORTER_OTLP_ENDPOINT:'bad',OTEL_RESOURCE_ATTRIBUTES:'bad',OPENAI_API_KEY:'test-only',ANTHROPIC_API_KEY:'test-only',AWS_ACCESS_KEY_ID:'test-only',AWS_SECRET_ACCESS_KEY:'test-only',NODE_OPTIONS:'--require /untrusted/module.cjs'};
  const env=scopedEnvironment('/tmp/fixture','explicit-fixture-key',ambient);
  assert.equal(env.OPENCODE_API_KEY,'explicit-fixture-key');assert.equal(env.OPENCODE_CONFIG,undefined);assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT,undefined);assert.equal(env.OTEL_RESOURCE_ATTRIBUTES,undefined);assert.equal(ambient.OPENCODE_API_KEY,'ambient-key');
  assert.equal(scopedEnvironment('/tmp/fixture',undefined,ambient).OPENCODE_API_KEY,undefined);
  for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','NODE_OPTIONS']) assert.equal(env[key],undefined);
  for(const key of ['PATH','LANG','https_proxy','NODE_EXTRA_CA_CERTS']) assert.equal(env[key],ambient[key]);
});

test('async version probe permits other code; scoped process is stopped and catalog stays local',async t=>{
  const spec=await fixture(t,'slow'),catalog=join(spec.root,'models.json');await writeFile(catalog,'{"fixture":{"models":{}}}');
  let responsive=false;setTimeout(()=>{responsive=true;},20);
  const server=await startOpenCode({...spec,apiKey:'explicit-fixture-key',baseURL:'https://opencode.ai/zen/v1',modelCatalogPath:catalog});t.after(()=>server.close());
  assert.equal(responsive,true);assert.equal(server.endpoint,'http://127.0.0.1:12345');
  const calls=(await readFile(spec.calls,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.key,true);assert.equal(call.cwd,await realpath(spec.directory));assert.equal(call.ambient,undefined);assert.equal(call.otel,undefined);}
  assert.deepEqual(calls[1].args,['serve','--hostname','127.0.0.1','--port','0']);
  const config=JSON.parse(await readFile(join(calls[1].config,'opencode.json'),'utf8'));assert.equal(config.providers.opencode.settings.baseURL,'https://opencode.ai/zen/v1');assert.ok(!JSON.stringify(config).includes('explicit-fixture-key'));
  assert.equal(await readFile(join(calls[1].cache,'opencode/models.json'),'utf8'),'{"fixture":{"models":{}}}');
  await server.close();await server.close();assert.throws(()=>process.kill(calls[1].pid,0),{code:'ESRCH'});
});

test('wrong version, startup failure and missing executable never echo child content',async t=>{
  for(const behavior of ['bad','malformed']){const spec=await fixture(t,behavior);await assert.rejects(startOpenCode(spec),error=>!error.message.includes('PRIVATE'));}
  const spec=await fixture(t);await assert.rejects(startOpenCode({...spec,binary:join(spec.root,'absent')}),/could not start/);
});

test('observed 5,251,376-byte catalog fits bounded startup; above 8 MiB fails before spawning',async t=>{
  const spec=await fixture(t),catalog=join(spec.root,'models.json');
  const json='{"fixture":{"models":{}}}',observedSize=5251376;
  await writeFile(catalog,json+' '.repeat(observedSize-json.length));
  const server=await startOpenCode({...spec,modelCatalogPath:catalog});t.after(()=>server.close());
  const calls=(await readFile(spec.calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal((await stat(join(calls[1].cache,'opencode/models.json'))).size,observedSize);
  await server.close();
  const oversized=await fixture(t),tooLarge=join(oversized.root,'models.json');
  const file=await open(tooLarge,'w');try{await file.truncate(8*1024*1024+1);}finally{await file.close();}
  await assert.rejects(startOpenCode({...oversized,modelCatalogPath:tooLarge}),/catalog exceeds startup limit/);
  await assert.rejects(readFile(oversized.calls),{code:'ENOENT'});
});

test('cancellation during async verification confirms child exit',async t=>{
  const spec=await fixture(t,'slow'),controller=new AbortController();
  const pending=startOpenCode({...spec,signal:controller.signal});
  const limit=Date.now()+2000;
  while(true){try{await readFile(spec.calls);break;}catch(error){if(error.code!=='ENOENT'||Date.now()>limit)throw error;await new Promise(resolve=>setTimeout(resolve,5));}}
  controller.abort();await assert.rejects(pending,/cancelled/);
  const calls=(await readFile(spec.calls,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);assert.throws(()=>process.kill(calls[0].pid,0),{code:'ESRCH'});
});
