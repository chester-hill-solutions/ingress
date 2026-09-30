import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,isAbsolute,extname} from 'node:path';
import {spawn} from 'node:child_process';

const LIMIT=1024*1024;
const METRIC_KEYS=['bytes','nonblankLines','codeLines','branches','functions','maxBraceDepth'];
const METHOD_LIMITS=['Lexical JavaScript proxy, not cyclomatic complexity or a quality score.','Branches count if/for/while/case/catch, ternary ?, and &&/||/?? outside literals/comments.','Functions count function keywords and =>; method declarations are excluded.','Brace depth includes object literals and blocks, not control-flow nesting.','Template text is excluded; interpolation expressions are scanned. Regex/division ambiguity makes lexical metrics unknown.','codeLines count lines containing non-comment tokens; multiline literal interiors are excluded.','analyzeCode does not validate grammar. Workspace syntax uses this Node runtime --check without evaluating source.','Only .js/.mjs/.cjs are supported. HTML/CSS/TypeScript/JSX are excluded, not treated as zero.'];

export function analyzeCode(text){
 if(typeof text!=='string')throw new TypeError('Code must be text');
 let i=0,line=1,depth=0,maxBraceDepth=0;const tokens=[],lines=new Set(),uncertainties=new Set();
 const step=()=>{const c=text[i++];if(c==='\n')line++;return c;};
 const token=value=>{tokens.push(value);lines.add(line);};
 const literal=quote=>{token('literal');step();let closed=false;while(i<text.length){const c=step();if(c==='\\'){if(i<text.length)step();continue;}if(c===quote){closed=true;break;}if(c==='\n')uncertainties.add('newline-in-quoted-string');}if(!closed)uncertainties.add('unterminated-string');};
 const regexEnd=()=>{let k=i+1,characterClass=false;while(k<text.length){const c=text[k++];if(c==='\n'||c==='\r')return null;if(c==='\\'){k++;continue;}if(c==='[')characterClass=true;if(c===']')characterClass=false;if(c==='/'&&!characterClass){while(/[a-z]/i.test(text[k]??'')&&k<text.length)k++;return k;}}return null;};
 const template=()=>{token('literal');step();let closed=false;while(i<text.length){if(text[i]==='\\'){step();if(i<text.length)step();continue;}if(text[i]==='`'){step();closed=true;break;}if(text[i]==='$'&&text[i+1]==='{'){step();step();scan(true);continue;}step();}if(!closed)uncertainties.add('unterminated-template');tokens.push('literal');};
 function scan(interpolation=false){let localDepth=0;while(i<text.length){const c=text[i],next=text[i+1];
  if(/\s/.test(c)){step();continue;}
  if(c==='/'&&next==='/'){while(i<text.length&&text[i]!=='\n')step();continue;}
  if(c==='/'&&next==='*'){step();step();let closed=false;while(i<text.length){if(text[i]==='*'&&text[i+1]==='/'){step();step();closed=true;break;}step();}if(!closed)uncertainties.add('unterminated-comment');continue;}
  if(c==='"'||c==="'"){literal(c);continue;}if(c==='`'){template();continue;}
  if(c==='/'){const previous=tokens.at(-1),end=regexEnd();const allowed=previous===undefined||['(','[','{','=',':',',',';','!','?','??','&&','||','=>','return','throw','yield','case'].includes(previous);
   if(end!==null&&(allowed||previous===')')){if(!allowed)uncertainties.add('ambiguous-regex-division');token('literal');while(i<end)step();continue;}
   if(allowed&&end===null)uncertainties.add('unterminated-or-ambiguous-regex');
  }
  if(c==='}'&&interpolation&&localDepth===0){step();return;}
  if(/[\p{ID_Start}_$]/u.test(c)){let word='';while(i<text.length&&/[\p{ID_Continue}$\u200C\u200D]/u.test(text[i]))word+=step();token(word);continue;}
  if(c==='\\')uncertainties.add('escaped-identifier-or-unsupported-token');
  if(c==='{'){localDepth++;depth++;maxBraceDepth=Math.max(maxBraceDepth,depth);}
  if(c==='}'){localDepth--;depth--;if(depth<0){uncertainties.add('unbalanced-braces');depth=0;}}
  const pair=c+next;if(['=>','&&','||','??','?.'].includes(pair)){token(pair);step();step();continue;}
  token(c);step();
 }if(interpolation)uncertainties.add('unterminated-template-interpolation');}
 scan();if(depth!==0)uncertainties.add('unbalanced-braces');
 let branches=0,functions=0;const branchTokens=new Set(['if','for','while','case','catch','?','&&','||','??']);
 for(let n=0;n<tokens.length;n++){const value=tokens[n],property=['.','?.'].includes(tokens[n-1])||tokens[n+1]===':';if(branchTokens.has(value)&&!property)branches++;if((value==='function'&&!property)||value==='=>')functions++;}
 const complete=uncertainties.size===0;
 return {bytes:Buffer.byteLength(text),nonblankLines:text.split(/\r?\n/).filter(v=>v.trim()).length,codeLines:complete?lines.size:null,branches:complete?branches:null,functions:complete?functions:null,maxBraceDepth:complete?maxBraceDepth:null,method:'lexical-js-proxy-v1',methodLimits:[...METHOD_LIMITS],lexicallyComplete:complete,syntax:'not-validated',uncertainties:[...uncertainties]};
}

async function syntaxValid(text,path){
 return new Promise(resolveCheck=>{const child=spawn(process.execPath,['--check','--input-type='+ (extname(path)==='.cjs'?'commonjs':'module')],{stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH}});let done=false,timedOut=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolveCheck(value);};const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},2000);child.once('error',()=>finish(null));child.once('exit',code=>finish(timedOut?null:code===0));child.stdin.on('error',()=>{});child.stdin.end(text);});
}

/** Declared JavaScript files only, confined/no symlinks, 1MiB each, max128. */
export async function measureWorkspace(root,paths){
 if(!Array.isArray(paths)||paths.length>128||paths.some(p=>typeof p!=='string'||!p||isAbsolute(p)||p.includes('\\')||p.split('/').some(v=>!v||v==='.'||v==='..')))throw new TypeError('Declare bounded relative code paths');
 root=await realpath(root);const files=[];
 for(const path of [...new Set(paths)]){
  const record={path,readable:false,syntax:'unknown',metrics:null,failure:null};files.push(record);
  if(!['.js','.mjs','.cjs'].includes(extname(path))){record.failure='unsupported-format';continue;}
  let file;
  try{
   const location=resolve(root,path),canonical=await realpath(location),rel=relative(root,canonical);if(canonical!==location||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('path-boundary');
   file=await open(location,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await file.stat();if(!before.isFile()||before.size>LIMIT)throw new Error('file-bound');
   const buffer=Buffer.alloc(LIMIT+1);let size=0;while(size<buffer.length){const result=await file.read(buffer,size,buffer.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}
   const after=await file.stat();if(size>LIMIT||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.ino!==after.ino)throw new Error('unstable-read');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));record.readable=true;
   const valid=await syntaxValid(text,path);record.syntax=valid===true?'valid':valid===false?'invalid':'unknown';
   if(valid===true){record.metrics=analyzeCode(text);record.metrics.syntax='valid';}else record.failure=valid===false?'invalid-syntax':'syntax-check-unavailable';
  }catch(error){record.failure=['path-boundary','file-bound','unstable-read'].includes(error.message)?error.message:error.code==='ENOENT'?'missing-file':'unreadable-file';}finally{await file?.close();}
 }
 const totals={},denominators={};for(const key of METRIC_KEYS){const values=files.map(file=>file.metrics?.[key]).filter(Number.isFinite);totals[key]=values.length?key==='maxBraceDepth'?Math.max(...values):values.reduce((a,b)=>a+b,0):null;denominators[key]=values.length;}
 return {method:'lexical-js-proxy-v1',methodLimits:[...METHOD_LIMITS],declaredFiles:files.length,readableFiles:files.filter(f=>f.readable).length,validFiles:files.filter(f=>f.syntax==='valid').length,totals,denominators,files};
}
