import { resolve } from 'node:path';
import { startBlindReview } from '../src/blind-review.mjs';
const args=process.argv.slice(2),directory=args.find(value=>value.startsWith('--directory='))?.slice(12), portText=args.find(value=>value.startsWith('--port='))?.slice(7)??'0';
if(!directory||!/^\d+$/.test(portText)||Number(portText)>65535||args.some(value=>!value.startsWith('--directory=')&&!value.startsWith('--port=')))throw Error('Usage: node scripts/blind-review.mjs --directory=<private flight directory> [--port=0]');
const view=await startBlindReview({directory:resolve(directory),port:Number(portText)});console.log(view.url);
const close=()=>view.close().then(()=>process.exit());process.once('SIGINT',close);process.once('SIGTERM',close);
