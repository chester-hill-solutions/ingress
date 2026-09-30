import test from 'node:test';
import assert from 'node:assert/strict';
import {describe,summarizeBenchmarks,renderBenchmarkReport} from '../src/benchmark-report.mjs';

const row=(changes={})=>({fixtureID:'dependency',repeat:1,condition:'awareness-on',outcome:'completed',correct:true,elapsedMs:10000,workMs:8000,setupMs:1000,actors:[{id:'a',admitted:true,outcome:'succeeded'},{id:'b',admitted:true,outcome:'succeeded'}],verification:{correct:true,checks:[{passed:true}],instructionChecks:[{passed:true}]},...changes});
const metrics=(changes={})=>({files:[{},{}],declaredFiles:2,readableFiles:2,validFiles:2,totals:{bytes:200,nonblankLines:8,codeLines:6,branches:2,functions:2,maxBraceDepth:1},denominators:{bytes:2,nonblankLines:2,codeLines:2,branches:2,functions:2,maxBraceDepth:2},...changes});

test('all assigned cohorts stay in denominators; observed and completed timings remain separate',()=>{
 const results=[row({complexity:metrics()}),row({repeat:2,correct:false,elapsedMs:20000,workMs:17000,verification:{correct:false,checks:[{passed:false}],instructionChecks:[{passed:true},{passed:false}]}}),row({repeat:3,outcome:'deadline',correct:false,elapsedMs:180000,workMs:179000,verification:{correct:true,checks:[{passed:true}],instructionChecks:[]},actors:[{admitted:true,outcome:'deadline'},{admitted:true,outcome:'succeeded'}]}),row({repeat:4,outcome:'failed',correct:false,elapsedMs:1000,workMs:0,verification:null,actors:[{admitted:false,outcome:'failed'},{admitted:false,outcome:'failed'}],errors:[{code:'startup'}]}),row({repeat:5,outcome:'not-run',correct:false,elapsedMs:0,workMs:0,verification:null,actors:[{admitted:false,outcome:'not-run'},{admitted:false,outcome:'not-run'}]})];
 const summary=summarizeBenchmarks(results),g=summary.groups[0];
 assert.equal(summary.assigned,5);
 assert.equal(g.assigned,5);assert.equal(g.attempted,4);assert.equal(g.completed,2);
 assert.equal(g.artifactCorrect,2,'independently correct deadline artifact remains visible');
 assert.equal(g.correctCompleted,1);
 assert.equal(g.notRun,1);assert.equal(g.timedOut,1);assert.equal(g.failed,1);
 assert.equal(g.assignedActors,10);assert.equal(g.admittedActors,6);assert.equal(g.nativeSucceededActors,5);
 assert.deepEqual(g.allOutcomeElapsedMs,{n:4,median:15000,min:1000,max:180000});
 assert.deepEqual(g.completedElapsedMs,{n:2,median:15000,min:10000,max:20000});
 assert.deepEqual(g.correctCompletedElapsedMs,{n:1,median:10000,min:10000,max:10000});
 assert.equal(g.allOutcomeWorkMs.n,4);assert.equal(g.completedWorkMs.n,2);
 assert.deepEqual(g.compliance,{passed:2,total:3,fraction:2/3});
 assert.equal(g.complianceTrials,2);assert.equal(g.verifiedTrials,3);
 assert.equal(g.errors,1);
});

test('complexity includes only available metrics with file and cohort denominators',()=>{
 const partial=metrics({readableFiles:1,validFiles:1,totals:{bytes:100,codeLines:null,branches:null},denominators:{bytes:1,codeLines:0,branches:0}});
 const empty=metrics({readableFiles:0,validFiles:0,totals:{bytes:null,codeLines:null},denominators:{bytes:0,codeLines:0}});
 const g=summarizeBenchmarks([row({complexity:metrics()}),row({repeat:2,complexity:partial}),row({repeat:3,complexity:empty}),row({repeat:4,complexity:null})]).groups[0];
 assert.equal(g.complexity.trialsMeasured,3);
 assert.equal(g.complexity.partialTrials,2);
 assert.equal(g.complexity.declaredFiles,6);assert.equal(g.complexity.readableFiles,3);assert.equal(g.complexity.validFiles,3);
 assert.deepEqual(g.complexity.metrics.bytes,{n:2,median:150,min:100,max:200,files:3});
 assert.deepEqual(g.complexity.metrics.codeLines,{n:1,median:6,min:6,max:6,files:2});
 assert.equal(g.complexity.metrics.branches.n,1);
 const unknown=summarizeBenchmarks([row({verification:null,complexity:empty})]).groups[0];
 assert.equal(unknown.compliance.fraction,null);
 assert.equal(unknown.complexity.metrics.functions.median,null);
 assert.equal(unknown.complexity.metrics.functions.files,0);
});

test('untouched valid seed is excluded from independently correct artifact complexity; exposure stays separate',()=>{
 const seed=metrics({totals:{bytes:10,codeLines:1},denominators:{bytes:1,codeLines:1}});
 const complete=metrics({totals:{bytes:200,codeLines:20},denominators:{bytes:2,codeLines:2}});
 const results=[row({correct:false,verification:{correct:false},complexity:seed,treatmentExposure:{status:'unknown'},validComparison:false}),row({repeat:2,complexity:complete,treatmentExposure:{status:'verified'},validComparison:true}),row({repeat:3,outcome:'deadline',correct:false,verification:{correct:true},complexity:null,treatmentExposure:{status:'failed'},validComparison:false}),row({repeat:4,outcome:'not-run',correct:false,verification:null,complexity:null})];
 const g=summarizeBenchmarks(results).groups[0];
 assert.equal(g.complexity.metrics.codeLines.median,10.5);
 assert.equal(g.complexityCorrectArtifacts.trialsEligible,2);
 assert.equal(g.complexityCorrectArtifacts.trialsMeasured,1);
 assert.equal(g.complexityCorrectArtifacts.metrics.codeLines.median,20);
 assert.equal(g.complexityCorrectArtifacts.metrics.codeLines.n,1);
 assert.equal(g.complexityCorrectArtifacts.metrics.codeLines.files,2);
 assert.deepEqual(g.treatmentExposure,{verified:1,unknown:1,failed:1,unrecorded:1});
 assert.equal(g.validComparisons,1);assert.equal(g.invalidComparisons,2);assert.equal(g.comparisonUnrecorded,1);
 const report=renderBenchmarkReport(results);
 assert.match(report,/Independently correct artifacts \| codeLines \| 20 \[20–20\] \| 1 \/ 2 \/ 4/);
 assert.match(report,/untouched seed/);
 assert.match(report,/do not establish active adaptation/);
});

test('pairs match fixture and repeat without picking duplicate, missing or unrun arms',()=>{
 const results=[row(),row({condition:'awareness-off',elapsedMs:12000,workMs:9000,correct:false,verification:{correct:false}}),row({repeat:2,outcome:'deadline',correct:false,elapsedMs:180000,verification:{correct:true}}),row({repeat:2,condition:'awareness-off',elapsedMs:20000}),row({repeat:3}),row({repeat:4}),row({repeat:4}),row({repeat:4,condition:'awareness-off'}),row({repeat:5}),row({repeat:5,condition:'awareness-off',outcome:'not-run',correct:false}),row({fixtureID:'other',repeat:1})];
 const pairs=summarizeBenchmarks(results).paired;
 const first=pairs.find(p=>p.fixtureID==='dependency'&&p.repeat===1);
 assert.equal(first.status,'observed');assert.equal(first.elapsedMsOnMinusOff,-2000);assert.equal(first.workMsOnMinusOff,-1000);assert.equal(first.completedElapsedMsOnMinusOff,-2000);assert.equal(first.correctnessOnMinusOff,1);
 const censored=pairs.find(p=>p.repeat===2);
 assert.equal(censored.deadlineCensored,true);assert.equal(censored.status,'observed-duration-censored');assert.equal(censored.elapsedMsOnMinusOff,160000);assert.equal(censored.completedElapsedMsOnMinusOff,null);
 assert.equal(censored.correctnessOnMinusOff,-1);assert.equal(censored.artifactCorrectnessOnMinusOff,0);
 assert.equal(censored.validComparison,false);
 assert.equal(pairs.find(p=>p.repeat===3).status,'incomplete');
 assert.equal(pairs.find(p=>p.repeat===4).status,'ambiguous-duplicates');
 assert.equal(pairs.find(p=>p.repeat===5).status,'not-run');
 assert.equal(pairs.find(p=>p.fixtureID==='other').status,'incomplete');
});

test('reports show unknown measurements, censor qualification, counts and escaped labels',()=>{
 const report=renderBenchmarkReport({results:[row({fixtureID:'<game>|\nunsafe',verification:null,complexity:null}),row({fixtureID:'<game>|\nunsafe',condition:'awareness-off',outcome:'not-run',correct:false,verification:null})]});
 assert.match(report,/Assigned cohorts: 2/);
 assert.match(report,/&lt;game&gt;\\\| unsafe/);
 assert.match(report,/Unknown \(n=0\)/);
 assert.match(report,/0 \/ 0 \(unknown\)/);
 assert.match(report,/deadline-censored/);
 assert.match(report,/not completion times/);
 assert.match(report,/No significance or composite quality grade/);
 assert.match(report,/not-run/);
 assert.deepEqual(describe([null,NaN,-1,2,4]),{n:2,median:3,min:2,max:4});
 assert.throws(()=>summarizeBenchmarks(null),TypeError);
 assert.throws(()=>summarizeBenchmarks([{}]),TypeError);
});

test('matrix groups separate configurations and models while configuration overview aggregates fixtures',()=>{
 const results=[row({configID:'gang-4',modelSet:'SpaceBunny',fixtureID:'one'}),row({configID:'gang-4',modelSet:'SpaceBunny',fixtureID:'two'}),row({configID:'gang-4',modelSet:'BigPickle',fixtureID:'one'}),row({configID:'gang-8',modelSet:'SpaceBunny',fixtureID:'one'}),row({configID:'gang-mixed',modelSet:'BigPickle+SpaceBunny',fixtureID:'one'})];
 const summary=summarizeBenchmarks(results);
 assert.equal(summary.groups.length,5);
 assert.equal(summary.configurations.length,4);
 const pooled=summary.configurations.find(c=>c.configID==='gang-4'&&c.modelSet==='SpaceBunny');
 assert.equal(pooled.assigned,2);assert.deepEqual(pooled.fixtureIDs,['one','two']);
 assert.deepEqual(summary.groups.find(g=>g.configID==='gang-mixed').models,['BigPickle','SpaceBunny']);
 assert.equal(summary.paired.length,0,'matrix rows do not enter legacy on/off comparisons');
 const report=renderBenchmarkReport(results);
 assert.match(report,/Configuration overview pools fixtures descriptively/);
 assert.match(report,/gang-4 \/ awareness-on \| SpaceBunny \| 2 \| 2 \/ 2/);
 assert.match(report,/not equal compute/);
 assert.match(report,/gang-mixed \/ BigPickle, SpaceBunny/);
});

test('stock comparisons require same model, seed and goal; actor counts never imply equal compute',()=>{
 const stock=(changes={})=>row({configID:'stock-parallel-pair',system:'stock',condition:'awareness-off',modelSet:'SpaceBunny',seedHash:'seed',workGoalHash:'goal',validComparison:true,elapsedMs:12000,...changes});
 const gang=(changes={})=>row({configID:'gang-8',system:'gangcode',condition:'awareness-on',modelSet:'SpaceBunny',seedHash:'seed',workGoalHash:'goal',baselineConfigID:'stock-parallel-pair',validComparison:true,actors:Array(8).fill({admitted:true,outcome:'succeeded'}),...changes});
 const rows=[stock(),gang(),stock({repeat:2}),gang({repeat:2,seedHash:'different'}),stock({repeat:3}),gang({repeat:3,workGoalHash:undefined}),stock({repeat:4}),gang({repeat:4,modelSet:'BigPickle+SpaceBunny'}),stock({repeat:5}),gang({repeat:5,outcome:'deadline',correct:false,elapsedMs:180000}),stock({repeat:6}),gang({repeat:6}),gang({repeat:6})];
 const pairs=summarizeBenchmarks(rows).configPaired;
 const first=pairs.find(p=>p.repeat===1);
 assert.equal(first.status,'observed');assert.equal(first.elapsedMsCandidateMinusBaseline,-2000);assert.equal(first.candidateActors,8);assert.equal(first.baselineActors,2);assert.equal(first.validComparison,true);
 assert.equal(pairs.find(p=>p.repeat===2).status,'work-identity-mismatch');
 assert.equal(pairs.find(p=>p.repeat===2).elapsedMsCandidateMinusBaseline,null);
 assert.equal(pairs.find(p=>p.repeat===3).status,'work-identity-unknown');
 assert.equal(pairs.find(p=>p.repeat===4).status,'incomplete','mixed-model candidate cannot use single-model stock arm');
 assert.equal(pairs.find(p=>p.repeat===5).status,'observed-duration-censored');
 assert.equal(pairs.find(p=>p.repeat===5).completedElapsedMsCandidateMinusBaseline,null);
 assert.equal(pairs.find(p=>p.repeat===6).status,'ambiguous-duplicates');
 const report=renderBenchmarkReport(rows);
 assert.match(report,/candidate minus stock baseline/);assert.match(report,/no equal-compute claim/);
});
