// Native runner bridge: private preparation is allowed before a modification grant.
// Only the issued base can publish. A changed base requires a new native edit turn;
// never silently relabel stale agent work as a fresh checkout.
import { sourceRevision } from '../../src/prototypes/checkout/graph-index.mjs';
import {introducedWrites} from './expansion-request.mjs';
export class NativeBridge {
  #system; #arm; #roles; #validate; #build; #prepared = new Map();
  constructor({ system, arm, roles, validate, buildIndex }) { this.#system = system; this.#arm = arm; this.#roles = roles; this.#validate = validate; this.#build=buildIndex; }
  async #grant(role, now) {
    return this.#arm === 'current' ? this.#system.checkout({ participantId: role.id, paths: [...new Set(role.writes.map(([path]) => path))] })
      : this.#system.checkout({ participantId: role.id, writes: role.writes.map(([path,symbol])=>({blockId:`${path}#${symbol}`})), leaseMs:900_000 }, now);
  }
  async begin(id, now) {
    const role=this.#roles.find(r=>r.id===id); if(!role)throw Error('unknown_actor');
    const grant=await this.#grant(role,now), files=grant.granted?grant.files:(await this.#system.snapshot(now)).files;
    this.#prepared.set(id,{role,grant:grant.granted?grant:null,revision:sourceRevision(files),base:structuredClone(files)});
    return {files:structuredClone(files),permission:grant.granted?'granted':'private preparation only',decision:grant};
  }
  async submit(id, candidate, now) {
    const state=this.#prepared.get(id); if(!state)throw Error('unknown_actor');
    const current=(await this.#system.snapshot(now)).files;
    if(!state.grant){
      const grant=await this.#grant(state.role,now);
      if(!grant.granted)return {admitted:false,reason:grant.reason,decision:grant};
      state.grant=grant;
      if(sourceRevision(grant.files)!==state.revision){
        state.base=structuredClone(grant.files);state.revision=sourceRevision(grant.files);
        return {admitted:false,reason:'native_rebase_required',files:structuredClone(grant.files)};
      }
    }
    const changed=Object.fromEntries(Object.entries(candidate).filter(([path,text])=>text!==state.base[path]));
    const removed=Object.keys(state.base).filter(path=>!Object.hasOwn(candidate,path));
    if(removed.length)return {admitted:false,reason:'source_deletion_not_supported',paths:removed};
    if(!Object.keys(changed).length){await this.release(id,now);return {admitted:true,unchanged:true};}
    const grant=state.grant;
    const result=await this.#system.submit({checkoutId:grant.checkoutId,participantId:id,files:changed,...(this.#arm==='blocks'?{validate:this.#validate}:{})},now);
    if(result.admitted){state.grant=null;return result;}
    return result;
  }
  async retry(id,now){
    await this.release(id,now);return this.begin(id,now);
  }
  async expand(id,candidate,additionalWrites,now){
    const state=this.#prepared.get(id);
    if(!state?.grant)return {admitted:false,granted:false,reason:'checkout_not_live'};
    if(typeof this.#system.expand!=='function'||this.#arm==='current')return {admitted:false,granted:false,reason:'expansion_not_supported'};
    if(!(await this.#system.snapshot(now)).grants.some(g=>g.checkoutId===state.grant.checkoutId&&g.participantId===id))return {admitted:false,granted:false,reason:'checkout_not_live'};
    const files=Object.fromEntries(Object.entries(candidate).filter(([path,text])=>text!==state.base[path]));
    if(this.#arm==='blocks'){
      if(typeof this.#build!=='function')return {admitted:false,granted:false,reason:'trusted_producer_required'};
      const proposed={...state.base,...files},index=this.#build(proposed);
      if(index.revision!==sourceRevision(proposed))return {admitted:false,granted:false,reason:'index_revision_mismatch'};
      return this.#system.expand({checkoutId:state.grant.checkoutId,participantId:id,candidate:proposed,blocks:index.blocks,edges:[],
        writes:[...state.role.writes.map(([path,symbol])=>({blockId:`${path}#${symbol}`})),...additionalWrites]},now);
    }
    return this.#system.expand({checkoutId:state.grant.checkoutId,participantId:id,files,additionalWrites},now);
  }
  async requestExpansion(id,candidate,now){
    const state=this.#prepared.get(id);
    if(!state?.grant)return {admitted:false,granted:false,reason:'checkout_not_live'};
    if(this.#arm==='current')return {admitted:false,granted:false,reason:'expansion_not_supported'};
    if(typeof this.#build!=='function')return {admitted:false,granted:false,reason:'trusted_producer_required'};
    if(!(await this.#system.snapshot(now)).grants.some(g=>g.checkoutId===state.grant.checkoutId&&g.participantId===id))return {admitted:false,granted:false,reason:'checkout_not_live'};
    try{
      // Match the baseline's assigned-path authority. A helper in another role's
      // file must not become a treatment-only implicit modification permission.
      const additionalWrites=introducedWrites(state.base,candidate,this.#build)
        .filter(write=>state.role.writes.some(([path])=>write.blockId.startsWith(path+'#')));
      const result=await this.expand(id,candidate,additionalWrites,now);
      return {...result,requestedAdditionalWrites:additionalWrites};
    }catch(error){return {admitted:false,granted:false,reason:'invalid_expansion',detail:error.message};}
  }
  async release(id,now){const state=this.#prepared.get(id);if(state?.grant){await this.#system.release({checkoutId:state.grant.checkoutId,participantId:id},now);state.grant=null;}}
  async snapshot(now){return this.#system.snapshot(now);}
}
