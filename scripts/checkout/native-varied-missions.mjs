import {mission,roles,referenceFiles} from './native-mission.mjs';
import {gradeNative} from './native-grader.mjs';
import {ledgerDirective,ledgerRoles,ledgerSeed,ledgerReference,gradeLedger} from './native-ledger-mission.mjs';
import {policyDirective,policyRoles,policySeed,policyReference,gradePolicy} from './native-policy-mission.mjs';
const contract=(id,producer,consumers,evidence)=>({id,producer:{path:producer[0],symbol:producer[1]},consumers:consumers.map(([path,symbol])=>({path,symbol})),evidence});
export function missionSet(seed,contracts){
 return [
  {id:'tax-stock',directive:mission,roles,seed,contracts,reference:referenceFiles,grade:gradeNative,seedTransform:'Original synthetic lab, unchanged'},
  {id:'refund-ledger',directive:ledgerDirective,roles:ledgerRoles,seed:ledgerSeed(seed),contracts:{...contracts,contracts:[...contracts.contracts,
   contract('refund-ledger-record','src/refunds.mjs#issueRefund'.split('#'),[['src/storage.mjs','encodeOrder'],['src/storage.mjs','decodeOrder'],['src/reports.mjs','format']], 'The declared refund ledger emitted by issueRefund is persisted and rendered by these consumers; fields and sequential balance are specified in the shared mission.')]},reference:ledgerReference,grade:gradeLedger,seedTransform:'Semantically equivalent legacy refundableBalance reduce is written as a loop in every arm before freezing; this bounds initial graph coverage without changing behavior'},
  {id:'policy-snapshot',directive:policyDirective,roles:policyRoles,seed:policySeed(seed),contracts:{...contracts,contracts:[...contracts.contracts,
   contract('compiled-policy-snapshot',['src/config.mjs','orderPolicy'],[['src/pricing.mjs','discountSubtotal'],['src/fulfillment.mjs','fulfillOrder'],['src/reports.mjs','format']], 'Consumers compile the policy values observed in their issued source into archival literals. These compile-time dependencies are operator-declared because final literal code need not import the provider.')]},reference:policyReference,grade:gradePolicy,seedTransform:'Add offerPercent 5 and returnWindowDays 14 to synthetic orderPolicy; legacy fields are unchanged in every arm'},
 ];
}
