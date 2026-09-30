import {isAbsolute} from 'node:path';
import {startBenchmarkDashboard} from '../src/benchmark-dashboard.mjs';

const args=process.argv.slice(2);
if(args.length!==1||!args[0].startsWith('--evidence=')||!isAbsolute(args[0].slice(11))){console.error('Usage: node scripts/benchmark-view.mjs --evidence=/absolute/path/evidence.json');process.exitCode=1;}
else{
 try{
  const dashboard=await startBenchmarkDashboard({evidencePath:args[0].slice(11)});
  console.log('Benchmark live view: '+dashboard.url);
  const stop=()=>{void dashboard.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 }catch{console.error('Benchmark view could not start');process.exitCode=1;}
}
