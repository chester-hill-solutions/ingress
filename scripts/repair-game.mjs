import {resolve} from 'node:path';
import {selectedProfile} from '../src/profile.mjs';
import {runGameRepair} from '../src/repair-game.mjs';
import {startDashboard} from '../src/dashboard.mjs';
const args=process.argv.slice(2);let buildRoot,priorEvidencePath,real=false,serve=false;
for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--real')real=true;else if(arg==='--serve')serve=true;else if(arg==='--root'||arg==='--prior'){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Explicit root and prior evidence required');const value=resolve(args[++i]);if(arg==='--root')buildRoot=value;else priorEvidencePath=value;}else throw new Error('Usage: node scripts/repair-game.mjs --real --root <existing-game> --prior <prior-evidence.json> [--serve]');}
if(!real||!buildRoot||!priorEvidencePath)throw new Error('Explicit native-model admission and root/prior paths required');
const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
const view={phase:'Preparing focused game completion',state:null,events:[],results:[]};let dashboard,lastPhase;
try{
 dashboard=serve?await startDashboard(()=>view):null;if(dashboard)console.log('Live repair view: '+dashboard.url);
 const profile=await selectedProfile();console.log('Finisher model: '+profile.model.providerID+'/'+profile.model.id);
 const result=await runGameRepair({profile,buildRoot,priorEvidencePath,signal:abort.signal,onUpdate(update){Object.assign(view,update,{results:[update.result]});dashboard?.push();if(update.phase!==lastPhase){lastPhase=update.phase;console.log(lastPhase);}}});
 console.log(JSON.stringify({buildRoot:result.buildRoot,correct:result.verification.correct,actor:result.actors[0].outcome,errors:result.errors,evidencePath:result.evidencePath}));
 if(dashboard&&!abort.signal.aborted){console.log('Read-only repair view remains available; Ctrl-C closes it.');await new Promise(resolve=>abort.signal.addEventListener('abort',resolve,{once:true}));}
}catch{console.error('Focused game repair could not complete; inspect its safe evidence if assigned.');process.exitCode=1;}
finally{await dashboard?.close();}
