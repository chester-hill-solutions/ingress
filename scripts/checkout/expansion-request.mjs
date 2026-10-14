// The trusted runner requests newly introduced blocks explicitly. Existing blocks
// remain read protections unless the caller explicitly asks to modify them.
import {sourceRevision} from '../../src/prototypes/checkout/graph-index.mjs';
export function introducedWrites(base,candidate,buildIndex){
 const before=buildIndex(base),after=buildIndex(candidate);
 if(before.revision!==sourceRevision(base)||after.revision!==sourceRevision(candidate))throw Error('index_revision_mismatch');
 const known=new Set(before.blocks.map(block=>block.id));
 return after.blocks.filter(block=>!known.has(block.id)&&candidate[block.path]!==base[block.path])
  .map(block=>({blockId:block.id}));
}
