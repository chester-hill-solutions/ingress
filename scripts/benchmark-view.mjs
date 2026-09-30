import {isAbsolute} from 'node:path';
import {startBenchmarkDashboard} from '../src/benchmark-dashboard.mjs';

const args=process.argv.slice(2);
const evidence=args.find(arg=>arg.startsWith('--evidence='))?.slice(11),portText=args.find(arg=>arg.startsWith('--port='))?.slice(7),port=portText===undefined?0:Number(portText);
if(args.some(arg=>!arg.startsWith('--evidence=')&&!arg.startsWith('--port='))||args.filter(arg=>arg.startsWith('--evidence=')).length!==1||args.filter(arg=>arg.startsWith('--port=')).length>1||!isAbsolute(evidence??'')||(portText!==undefined&&!/^\d+$/.test(portText))||!Number.isInteger(port)||port<0||port>65535){console.error('Usage: node scripts/benchmark-view.mjs --evidence=/absolute/path/evidence.json [--port=65392]');process.exitCode=1;}
else{
 try{
  const dashboard=await startBenchmarkDashboard({evidencePath:evidence,port});
  console.log('Benchmark live view: '+dashboard.url);
  const stop=()=>{void dashboard.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 }catch{console.error('Benchmark view could not start');process.exitCode=1;}
}
