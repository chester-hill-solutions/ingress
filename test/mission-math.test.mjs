import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mathMissions, verifyMathMission } from '../fixtures/missions/math.mjs';

// Test submissions only. The circulation algorithm uses residual augmentation and
// negative-cycle cancellation; the trusted grader enumerates integer assignments.
// Graph test submissions use disjoint sets, independently of the grader's BFS.
function referenceLibrary() {
  const fail = () => { throw TypeError('invalid'); };
  const clone = x => JSON.parse(JSON.stringify(x));
  const dec = x => typeof x === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(x);
  const nat = x => dec(x) && !x.startsWith('-');
  const batch = (xs, fn) => { if (!Array.isArray(xs) || !xs.length || xs.length > 32) fail(); return xs.map(fn); };
  const node = (v,n) => Number.isInteger(v) && v >= 0 && v < n;
  const ids = es => es.every(e => typeof e.id === 'string' && /^[\x00-\x7f]{1,32}$/.test(e.id)) && new Set(es.map(e=>e.id)).size === es.length;
  function network(N) {
    if (!N || !Number.isInteger(N.n) || N.n<1 || N.n>12 || !Array.isArray(N.balances) || N.balances.length!==N.n || N.balances.some(b=>!Number.isInteger(b)||Math.abs(b)>24) || N.balances.reduce((a,b)=>a+b,0)!==0 || N.balances.filter(b=>b>0).reduce((a,b)=>a+b,0)>24 || !Array.isArray(N.edges) || N.edges.length>36 || !ids(N.edges) || N.edges.some(e=>!node(e.u,N.n)||!node(e.v,N.n)||!Number.isInteger(e.capacity)||e.capacity<0||e.capacity>8||!dec(e.cost)||BigInt(e.cost)>10n**18n||BigInt(e.cost)<-(10n**18n))) fail();
    return {n:N.n,balances:[...N.balances],edges:N.edges.map(({id,u,v,capacity,cost})=>({id,u,v,capacity,cost}))};
  }
  function flow(N,f,conserve=false) { network(N); if (!Array.isArray(f)||f.length!==N.edges.length||f.some((x,i)=>!Number.isInteger(x)||x<0||x>N.edges[i].capacity)) fail(); if(conserve) { const b=Array(N.n).fill(0); N.edges.forEach((e,i)=>{b[e.u]+=f[i];b[e.v]-=f[i];}); if(b.some((v,i)=>v!==N.balances[i])) fail(); } return f; }
  const cost=(N,f)=>N.edges.reduce((a,e,i)=>a+BigInt(e.cost)*BigInt(f[i]),0n);
  function arcs(N,f) { return N.edges.flatMap((e,i)=>[...(f[i]<e.capacity?[{i,u:e.u,v:e.v,capacity:e.capacity-f[i],cost:BigInt(e.cost),sign:1}]:[]),...(f[i]>0?[{i,u:e.v,v:e.u,capacity:f[i],cost:-BigInt(e.cost),sign:-1}]:[])]); }
  function solve(N) {
    network(N); const f=N.edges.map(()=>0), remaining=[...N.balances];
    while(remaining.some(x=>x>0)) {
      const s=remaining.findIndex(x=>x>0), prev=Array(N.n).fill(null), seen=new Set([s]), queue=[s], A=arcs(N,f); let t=-1;
      for(let q=0;q<queue.length&&t<0;q++) {const u=queue[q];for(const a of A)if(a.u===u&&!seen.has(a.v)){seen.add(a.v);prev[a.v]=a;queue.push(a.v);if(remaining[a.v]<0){t=a.v;break;}}}
      if(t<0) {const vertices=[...seen].sort((a,b)=>a-b);const deficit=vertices.reduce((sum,v)=>sum+N.balances[v],0)-N.edges.filter(e=>seen.has(e.u)&&!seen.has(e.v)).reduce((sum,e)=>sum+e.capacity,0);return {status:'infeasible',cut:{vertices,deficit}};}
      const path=[];for(let v=t;v!==s;v=prev[v].u)path.push(prev[v]);const amount=Math.min(remaining[s],-remaining[t],...path.map(a=>a.capacity));for(const a of path)f[a.i]+=a.sign*amount;remaining[s]-=amount;remaining[t]+=amount;
    }
    for(let iterations=0;iterations<10000;iterations++) {
      const A=arcs(N,f), d=Array(N.n).fill(0n), prev=Array(N.n).fill(null);let changed=-1;
      for(let pass=0;pass<N.n;pass++){changed=-1;for(const a of A)if(d[a.v]>d[a.u]+a.cost){d[a.v]=d[a.u]+a.cost;prev[a.v]=a;changed=a.v;}}
      if(changed<0){const objective=String(cost(N,f));return {status:'optimal',flow:f,objective,potentials:d.map(String),dualObjective:objective};}
      let v=changed;for(let i=0;i<N.n;i++)v=prev[v].u;const start=v, cycle=[];do{cycle.push(prev[v]);v=prev[v].u;}while(v!==start);const amount=Math.min(...cycle.map(a=>a.capacity));for(const a of cycle)f[a.i]+=amount*a.sign;
    }
    throw Error('iteration bound');
  }
  function audit(N,s) {
    network(N);try {
      if(s?.status==='infeasible'){const vs=s.cut.vertices;if(!Array.isArray(vs)||!vs.length||vs.some((v,i)=>!node(v,N.n)||i>0&&v<=vs[i-1]))return {valid:false};const set=new Set(vs), deficit=vs.reduce((a,v)=>a+N.balances[v],0)-N.edges.filter(e=>set.has(e.u)&&!set.has(e.v)).reduce((a,e)=>a+e.capacity,0);return {valid:deficit>0&&deficit===s.cut.deficit};}
      if(s?.status!=='optimal'||!dec(s.objective)||!dec(s.dualObjective)||!Array.isArray(s.potentials)||s.potentials.length!==N.n||!s.potentials.every(dec))return {valid:false};flow(N,s.flow,true);const p=s.potentials.map(BigInt);let dual=N.balances.reduce((a,b,v)=>a-BigInt(b)*p[v],0n);
      for(let i=0;i<N.edges.length;i++){const e=N.edges[i],r=BigInt(e.cost)+p[e.u]-p[e.v];if(s.flow[i]<e.capacity&&r<0n||s.flow[i]>0&&r>0n)return {valid:false};dual+=BigInt(e.capacity)*(r<0n?r:0n);}
      return {valid:String(cost(N,s.flow))===s.objective&&String(dual)===s.dualObjective&&s.objective===s.dualObjective};
    } catch{return {valid:false};}
  }
  function sensitivity(N) {return N.edges.map((e,i)=>({edgeID:e.id,...Object.fromEntries([['minus',-1],['plus',1]].map(([key,delta])=>{if(e.capacity+delta<0||e.capacity+delta>8)return [key,null];const n=clone(N);n.edges[i].capacity+=delta;const s=solve(n);return [key,{status:s.status,objective:s.status==='optimal'?s.objective:null}];}))}));}
  function decomposition(N,f) {
    flow(N,f,true);const left=[...f],b=[...N.balances],paths=[],cycles=[];
    while(b.some(x=>x>0)){const s=b.findIndex(x=>x>0),queue=[s],prev=Array(N.n).fill(-1),seen=new Set([s]);let t=-1;
      for(let q=0;q<queue.length&&t<0;q++)for(let i=0;i<N.edges.length;i++){const e=N.edges[i];if(left[i]>0&&e.u===queue[q]&&!seen.has(e.v)){seen.add(e.v);prev[e.v]=i;queue.push(e.v);if(b[e.v]<0){t=e.v;break;}}}
      if(t<0)fail();const ei=[];for(let v=t;v!==s;v=N.edges[prev[v]].u)ei.unshift(prev[v]);const amount=Math.min(b[s],-b[t],...ei.map(i=>left[i]));ei.forEach(i=>left[i]-=amount);b[s]-=amount;b[t]+=amount;paths.push({vertices:[s,...ei.map(i=>N.edges[i].v)],edgeIDs:ei.map(i=>N.edges[i].id),amount});
    }
    while(left.some(x=>x>0)){let v=N.edges[left.findIndex(x=>x>0)].u;const visited=new Map(),vertices=[],ei=[];while(!visited.has(v)){visited.set(v,vertices.length);vertices.push(v);const i=N.edges.findIndex((e,i)=>e.u===v&&left[i]>0);if(i<0)fail();ei.push(i);v=N.edges[i].v;}const start=visited.get(v), edges=ei.slice(start),vs=[...vertices.slice(start),v],amount=Math.min(...edges.map(i=>left[i]));edges.forEach(i=>left[i]-=amount);cycles.push({vertices:vs,edgeIDs:edges.map(i=>N.edges[i].id),amount});}
    return {paths,cycles};
  }
  function graph(G) {if(!G||!Number.isInteger(G.n)||G.n<1||G.n>10||!Array.isArray(G.edges)||G.edges.length>18||!ids(G.edges)||G.edges.some(e=>!node(e.u,G.n)||!node(e.v,G.n))||!G.p||!nat(G.p.numerator)||!nat(G.p.denominator)||BigInt(G.p.denominator)===0n||BigInt(G.p.denominator)>10n**18n||BigInt(G.p.numerator)>BigInt(G.p.denominator))fail();return {n:G.n,edges:G.edges.map(({id,u,v})=>({id,u,v})),p:{...G.p}};}
  function components(G,selected=G.edges.map(e=>e.id),removed=-1) {const parent=Array.from({length:G.n},(_,i)=>i),find=x=>parent[x]===x?x:(parent[x]=find(parent[x]));const active=new Set(selected);if(active.size!==selected.length||selected.some(id=>!G.edges.some(e=>e.id===id)))fail();for(const e of G.edges)if(active.has(e.id)&&e.u!==removed&&e.v!==removed)parent[find(e.u)]=find(e.v);const groups=new Map();for(let v=0;v<G.n;v++)if(v!==removed){const r=find(v);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(v);}return [...groups.values()].sort((a,b)=>a[0]-b[0]);}
  const fraction=(a,b)=>{let x=a,y=b;while(y)[x,y]=[y,x%y];return {numerator:String(a/x),denominator:String(b/x)};};
  const probability=(cs,p,m)=>{const a=BigInt(p.numerator),b=BigInt(p.denominator);return fraction(cs.reduce((sum,c,k)=>sum+c*a**BigInt(k)*(b-a)**BigInt(m-k),0n),b**BigInt(m));};
  function combinatorics(G) {
    const m=G.edges.length,counts=Array(m+1).fill(0n),edgeCounts=Array(m).fill(0n),forced=Array.from({length:m},()=>[Array(m).fill(0n),Array(m).fill(0n)]);let trees=0n;
    for(let mask=0;mask<2**m;mask++){const selected=G.edges.filter((_,i)=>mask&2**i),k=selected.length;if(components(G,selected.map(e=>e.id)).length!==1)continue;counts[k]++;if(k===G.n-1){trees++;G.edges.forEach((_,i)=>{if(mask&2**i)edgeCounts[i]++;});}G.edges.forEach((_,i)=>{const on=Number(Boolean(mask&2**i));forced[i][on][k-on]++;});}
    return {trees:{count:String(trees),edgeCounts:G.edges.map((e,i)=>({id:e.id,count:String(edgeCounts[i])}))},reliability:{connectedBySize:counts.map(String),probability:probability(counts,G.p,m),influence:G.edges.map((e,i)=>{const on=probability(forced[i][1],G.p,m-1),off=probability(forced[i][0],G.p,m-1);return {id:e.id,...fraction(BigInt(on.numerator)*BigInt(off.denominator)-BigInt(off.numerator)*BigInt(on.denominator),BigInt(on.denominator)*BigInt(off.denominator))};})}};
  }
  function structure(G){const base=components(G).length;return {bridges:G.edges.flatMap(e=>{const c=components(G,G.edges.filter(x=>x.id!==e.id).map(x=>x.id));return c.length>base?[{id:e.id,components:c}]:[];}),articulations:Array.from({length:G.n},(_,v)=>v).flatMap(vertex=>{const c=components(G,undefined,vertex);return c.length>base?[{vertex,components:c}]:[];})};}
  function transforms(G){return {deletions:G.edges.map(e=>({id:e.id,graph:{...clone(G),edges:G.edges.filter(x=>x.id!==e.id)}})),contractions:G.edges.map(e=>{const low=Math.min(e.u,e.v),high=Math.max(e.u,e.v),reps=Array.from({length:G.n},(_,i)=>i).filter(i=>e.u===e.v||i!==high),map=v=>reps.indexOf(e.u!==e.v&&v===high?low:v);return {id:e.id,graph:{n:reps.length,edges:G.edges.filter(x=>x.id!==e.id).map(x=>({id:x.id,u:map(x.u),v:map(x.v)})),p:{...G.p}}};})};}
  function witness(G){const c=components(G);if(c.length>1)return {treeEdgeIDs:null,disconnectedComponents:c};const chosen=[];for(const e of G.edges){if(components(G,chosen).length>components(G,[...chosen,e.id]).length)chosen.push(e.id);}return {treeEdgeIDs:chosen,disconnectedComponents:null};}
  return {
    validateNetworks:xs=>batch(xs,network),costFlows:xs=>batch(xs,({network:N,flow:f})=>{flow(N,f);return String(cost(N,f));}),
    residualNetworks:xs=>batch(xs,({network:N,flow:f})=>{flow(N,f);return arcs(N,f).map(a=>({edgeID:N.edges[a.i].id,u:a.u,v:a.v,capacity:a.capacity,cost:String(a.cost),direction:a.sign===1?'forward':'backward'}));}),
    solveNetworks:xs=>batch(xs,solve),auditNetworks:xs=>batch(xs,({network:N,solution:s})=>audit(N,s)),analyzeCapacity:xs=>batch(xs,N=>{network(N);return sensitivity(N);}),decomposeFlows:xs=>batch(xs,({network:N,flow:f})=>decomposition(N,f)),
    reportNetworks:xs=>batch(xs,N=>{network(N);const solution=solve(N);return {solution,audit:audit(N,solution),sensitivity:sensitivity(N),decomposition:solution.status==='optimal'?decomposition(N,solution.flow):null};}),
    validateGraphs:xs=>batch(xs,graph),componentGraphs:xs=>batch(xs,({graph:G,activeEdgeIDs})=>{graph(G);const c=components(G,activeEdgeIDs);return {components:c,connected:c.length===1};}),treeGraphs:xs=>batch(xs,G=>{graph(G);return combinatorics(G).trees;}),reliabilityGraphs:xs=>batch(xs,G=>{graph(G);return combinatorics(G).reliability;}),structureGraphs:xs=>batch(xs,G=>{graph(G);return structure(G);}),transformGraphs:xs=>batch(xs,G=>{graph(G);return transforms(G);}),witnessGraphs:xs=>batch(xs,G=>{graph(G);return witness(G);}),reportGraphs:xs=>batch(xs,G=>{graph(G);const c=components(G);return {components:{components:c,connected:c.length===1},...combinatorics(G),structure:structure(G),transforms:transforms(G),witness:witness(G)};})
  };
}

async function workspace(fixture, reference=true) {
  const root=await mkdtemp(join(tmpdir(),'math-mission-test-'));
  for(const [path,text] of Object.entries(fixture.files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),text);}
  if(reference){const exports=Object.entries(fixture.files).filter(([path])=>fixture.editablePaths.includes(path)).map(([path,text])=>[path,/export function (\w+)/.exec(text)[1]]);for(const [path,name] of exports)await writeFile(join(root,path),`const lib=(${referenceLibrary.toString()})();\nexport const ${name}=lib.${name};\n`);}
  return root;
}
async function grade(fixture,change,reference=true){const root=await workspace(fixture,reference);try{if(change)await change(root);return await verifyMathMission(fixture.id,root);}finally{await rm(root,{recursive:true,force:true});}}
const [network,graph]=mathMissions;
const failed=(r,name)=>r.checks.some(c=>c.name===name&&!c.passed);

test('two decomposable missions expose eight streams, bounded goals, batch review and no private oracle',()=>{
  for(const f of mathMissions){assert.equal(f.workstreams.length,8);assert.ok(Buffer.byteLength(f.goal)<=7000);assert.ok(f.workstreams.every(s=>Buffer.byteLength(s.brief)<=1200));assert.deepEqual(f.reviewInvocation.args,[JSON.parse(f.files['samples.json'])]);assert.ok(Object.values(f.files).every(t=>!t.includes('bruteFlow')&&!t.includes('graphOracle')));}
});
test('independent test submissions satisfy all exact circulation criteria',async()=>{const r=await grade(network);assert.equal(r.correct,true,JSON.stringify(r));assert.equal(r.checks.length,network.criteria.length);});
test('independent test submissions satisfy all exact graph criteria',async()=>{const r=await grade(graph);assert.equal(r.correct,true,JSON.stringify(r));assert.equal(r.checks.length,graph.criteria.length);});
test('unimplemented seeds retain every criterion as a failed executable outcome',async()=>{for(const f of mathMissions){const r=await grade(f,null,false);assert.equal(r.correct,false);assert.ok(f.criteria.every(c=>r.checks.some(x=>x.name===c.id)));assert.ok(r.checks.some(c=>!c.passed));}});
test('feasible but suboptimal circulation and forged dual certificates fail',async()=>{
  const r=await grade(network,async root=>{await writeFile(join(root,'solver.mjs'),`const lib=(${referenceLibrary.toString()})();export function solveNetworks(xs){return lib.solveNetworks(xs).map((s,i)=>i===0?{...s,flow:[1,1,1],objective:'9',dualObjective:'9',potentials:['0','0','0']}:s);}`);});
  assert.ok(failed(r,'network.primal_dual_optimality'));assert.equal(r.correct,false);
});
test('Number accumulation cannot pass large cancelling exact costs',async()=>{const r=await grade(network,async root=>writeFile(join(root,'cost.mjs'),`export const costFlows=xs=>xs.map(({network,flow})=>String(network.edges.reduce((sum,e,i)=>sum+Number(e.cost)*flow[i],0)));`));assert.ok(failed(r,'network.exact_cost'));});
test('auditor accepting forged claims fails independently of solver success',async()=>{const r=await grade(network,async root=>writeFile(join(root,'audit.mjs'),`export const auditNetworks=xs=>xs.map(()=>({valid:true}));`));assert.ok(failed(r,'network.independent_audit_forged'));assert.ok(!failed(r,'network.primal_dual_optimality'));});
test('ignoring negative circulation violates optimality even with zero supply',async()=>{const r=await grade(network,async root=>writeFile(join(root,'solver.mjs'),`const lib=(${referenceLibrary.toString()})();export function solveNetworks(xs){return lib.solveNetworks(xs).map((s,i)=>xs[i].balances.every(b=>b===0)&&xs[i].edges.length?{status:'optimal',flow:xs[i].edges.map(()=>0),objective:'0',dualObjective:'0',potentials:xs[i].balances.map(()=> '0')}:s);}`));assert.ok(failed(r,'network.primal_dual_optimality'));});
test('tree count invariants alone cannot replace independently correct counts',async()=>{const r=await grade(graph,async root=>writeFile(join(root,'trees.mjs'),`const lib=(${referenceLibrary.toString()})();export const treeGraphs=xs=>lib.treeGraphs(xs).map(r=>({count:String(BigInt(r.count)*2n),edgeCounts:r.edgeCounts.map(e=>({...e,count:String(BigInt(e.count)*2n)}))}));`));assert.ok(failed(r,'graph.exact_spanning_trees'));assert.ok(!failed(r,'graph.reliability_precision_and_influence'));});
test('rounded graph probabilities and fabricated witnesses fail despite correct tree counts',async()=>{const r=await grade(graph,async root=>{
  await writeFile(join(root,'reliability.mjs'),`const lib=(${referenceLibrary.toString()})();export function reliabilityGraphs(xs){return lib.reliabilityGraphs(xs).map(r=>({...r,probability:{numerator:String(Math.round(Number(r.probability.numerator))),denominator:r.probability.denominator}}));}`);
  await writeFile(join(root,'witness.mjs'),`export const witnessGraphs=xs=>xs.map(()=>({treeEdgeIDs:[],disconnectedComponents:null}));`);
});assert.ok(failed(r,'graph.reliability_precision_and_influence'));assert.ok(failed(r,'graph.constructive_tree_or_cut'));assert.ok(!failed(r,'graph.exact_spanning_trees'));});
test('protected mathematical contract changes fail instruction checks',async()=>{const r=await grade(graph,async root=>writeFile(join(root,'contracts.md'),'weakened'));assert.equal(r.correct,false);assert.ok(r.instructionChecks.some(c=>!c.passed));});
