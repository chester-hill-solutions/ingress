import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyzeCode,measureWorkspace} from '../src/benchmark-metrics.mjs';

test('lexical proxies exclude comments, quoted text and regular expressions',()=>{
 const code=`// if function => { ? &&\n/* while catch { */\nconst description = 'if function ? {';\nconst pattern = /=if(?:while|function){1,3}/;\nfunction f(value) {\n if (value && value.ready) return value.ready ? 1 : 0;\n return 0;\n}\nconst run = value => value ?? false;\nconst properties = {if: 1, function: 2};\nproperties.if;`;
 const result=analyzeCode(code);
 assert.equal(result.lexicallyComplete,true);
 assert.equal(result.functions,2);
 assert.equal(result.branches,4);
 assert.equal(result.maxBraceDepth,1);
 assert.equal(result.nonblankLines,11);
 assert.equal(result.codeLines,9);
 assert.equal(result.bytes,Buffer.byteLength(code));
 assert.equal(result.syntax,'not-validated');
 assert.match(result.methodLimits.join(' '),/not cyclomatic/);
});

test('templates exclude text but inspect nested interpolation expressions',()=>{
 const result=analyzeCode('const x = `if function { ? ${(() => { if (ok) return `while ${x || y}`; })()}`;');
 assert.equal(result.lexicallyComplete,true);
 assert.equal(result.functions,1);
 assert.equal(result.branches,2);
 assert.equal(result.maxBraceDepth,1);
 assert.equal(analyzeCode('const ifñ = 1;').branches,0);
});

test('ambiguous or incomplete lexical input produces unknown proxies, never zero',()=>{
 for(const code of ['const x = "unfinished','/* missing close','const x = `unfinished ${x','function f() {','if (x) /a?{2}/.test(x);','const x = /unterminated']){
  const result=analyzeCode(code);
  assert.equal(result.lexicallyComplete,false,code);
  assert.ok(result.uncertainties.length>0);
  for(const key of ['codeLines','branches','functions','maxBraceDepth'])assert.equal(result[key],null,`${code} ${key}`);
  assert.equal(result.bytes,Buffer.byteLength(code));
 }
 assert.throws(()=>analyzeCode(null),TypeError);
});

test('workspace measurement excludes invalid, missing, unsupported, oversized and linked files with explicit denominators',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-metrics-'));
 try{
  await writeFile(join(root,'valid.mjs'),'export const run = value => value ? 1 : 0;\n');
  await writeFile(join(root,'common.cjs'),'module.exports = function () { return 1; };\n');
  await writeFile(join(root,'invalid.mjs'),'export const broken = ;\n');
  await writeFile(join(root,'oversize.mjs'),' '.repeat(1024*1024+1));
  await writeFile(join(root,'page.html'),'<script>if (x) throw x;</script>');
  await symlink(join(root,'valid.mjs'),join(root,'linked.mjs'));
  const paths=['valid.mjs','common.cjs','invalid.mjs','missing.mjs','oversize.mjs','page.html','linked.mjs','valid.mjs'];
  const result=await measureWorkspace(root,paths);
  assert.equal(result.declaredFiles,7);
  assert.equal(result.readableFiles,3);
  assert.equal(result.validFiles,2);
  assert.equal(result.denominators.branches,2);
  assert.equal(result.totals.branches,1);
  assert.equal(result.totals.functions,2);
  assert.equal(result.totals.maxBraceDepth,1);
  const files=Object.fromEntries(result.files.map(f=>[f.path,f]));
  assert.equal(files['invalid.mjs'].failure,'invalid-syntax');
  assert.equal(files['missing.mjs'].failure,'missing-file');
  assert.equal(files['oversize.mjs'].failure,'file-bound');
  assert.equal(files['page.html'].failure,'unsupported-format');
  assert.equal(files['linked.mjs'].failure,'path-boundary');
  for(const path of paths.filter(p=>!['valid.mjs','common.cjs'].includes(p)))assert.equal(files[path].metrics,null);
  assert.equal(files['valid.mjs'].metrics.syntax,'valid');
  const absent=await measureWorkspace(root,['missing.mjs']);
  assert.equal(absent.totals.bytes,null);
  assert.equal(absent.denominators.bytes,0);
  await assert.rejects(measureWorkspace(root,['../valid.mjs']),TypeError);
  await assert.rejects(measureWorkspace(root,['/absolute.mjs']),TypeError);
  await assert.rejects(measureWorkspace(root,Array(129).fill('valid.mjs')),TypeError);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('syntax validation never evaluates declared source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'benchmark-noeval-'));
 try{
  await writeFile(join(root,'never.mjs'),'throw new Error("Do not execute source");\nprocess.exit(99);');
  const result=await measureWorkspace(root,['never.mjs']);
  assert.equal(result.validFiles,1);
  assert.equal(result.files[0].failure,null);
 }finally{await rm(root,{recursive:true,force:true});}
});
