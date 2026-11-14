import {createSource} from './source.mjs';
import {AcquisitionEngine} from './engine.mjs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * End-to-end demonstration against an in-process synthetic supplier.
 * No real paid endpoint is ever contacted: the client refuses non-loopback
 * addresses and the source here listens on a random local port.
 */
const directory=await mkdtemp(join(tmpdir(),'acquisition-demo-'));
const source=await createSource();
const ledgerPath=join(directory,'ledger.json');
const now=Date.now();
const deadline=new Date(now+4*60*60*1000).toISOString();

let purchasePosts=0;
const orderLookups={fail:false};
const countingFetch=async(url,options)=>{
  if(String(url).includes('/purchase'))purchasePosts+=1;
  if(orderLookups.fail&&String(url).includes('/orders/'))throw new TypeError('模拟查单网络中断');
  return globalThis.fetch(url,options);
};

const options={sourceUrl:source.url,ledgerPath,clock:()=>now,fetchImpl:countingFetch,resultTtlMs:60*60*1000};
const engine=await AcquisitionEngine.open(options);

function heading(text){console.log(`\n== ${text} ==`);}
function show(value){console.log(JSON.stringify(value,null,2));}
function lineSummary(line){
  return {entityKey:line.entityKey,phase:line.phase,reserved:line.reserved,actual:line.actual,released:line.released,unknownAmount:line.unknownAmount,overage:line.overage,requestId:line.requestId,disclosureId:line.disclosureId,error:line.lastError?.code??null};
}

try{
  heading('准备：本地合成供应商');
  show({source:source.url,ledger:ledgerPath,fixture:source.state});

  heading('场景 1：报价上涨（预占不足以覆盖最终报价）');
  await engine.defineOrder({id:'PO-PRICE',purpose:'授信评估',version:1,budget:20,deadline});
  const {line:raise}=await engine.enqueue({orderId:'PO-PRICE',entityKey:'enterprise-1'});
  // The supplier changes its quote after reservation but before POST /purchase.
  const raiser=await AcquisitionEngine.open({...options,hooks:{beforePurchase:async()=>{source.state.price=7;}}});
  const raised=await raiser.processLine(raise.id);
  show({...lineSummary(raised),attempts:raised.attempts.map(attempt=>[attempt.action,attempt.outcome,attempt.price??attempt.charged??null])});
  source.state.price=3;

  heading('场景 2：响应丢失 + 查单中断 → 未知费用 → 人工核销');
  source.state.dropResponse=true;
  orderLookups.fail=true;
  await engine.defineOrder({id:'PO-DROP',purpose:'授信评估',version:1,budget:20,deadline});
  const {line:dropped}=await engine.enqueue({orderId:'PO-DROP',entityKey:'enterprise-2'});
  const unknown=await engine.processLine(dropped.id);
  show({...lineSummary(unknown),reportUnknown:engine.report().unknown.map(item=>({requestId:item.requestId,amount:item.amount,lastError:item.lastError?.code}))});
  orderLookups.fail=false;
  source.state.dropResponse=false;
  const manual=await engine.resolveUnknown({
    lineId:dropped.id,
    outcome:'requery',
    operator:'demo-finance',
    evidence:'供应商对账单确认唯一披露请求号已扣费 3'
  });
  show({...lineSummary(manual),sourceOrderExists:Boolean(source.state.orders[manual.requestId])});

  heading('场景 3：取消交错（排队停止、已收费保留）');
  await engine.defineOrder({id:'PO-CANCEL',purpose:'授信评估',version:1,budget:20,deadline});
  const {line:paid}=await engine.enqueue({orderId:'PO-CANCEL',entityKey:'enterprise-3'});
  await engine.processLine(paid.id);
  await engine.enqueue({orderId:'PO-CANCEL',entityKey:'enterprise-4'});
  const cancelled=await engine.cancelOrder('PO-CANCEL',{reason:'部门取消剩余需求',actor:'demo'});
  show({order:cancelled.id,status:cancelled.status,actual:cancelled.actual,released:cancelled.released,lines:cancelled.lines.map(lineSummary)});

  heading('场景 4：预算隔离（不能挪用其他采购单预算）');
  await engine.defineOrder({id:'PO-SMALL',purpose:'授信评估',version:1,budget:1,deadline});
  await engine.defineOrder({id:'PO-SPARE',purpose:'授信评估',version:1,budget:100,deadline});
  await engine.enqueue({orderId:'PO-SMALL',entityKey:'enterprise-5'});
  await engine.enqueue({orderId:'PO-SPARE',entityKey:'enterprise-6'});
  const small=await engine.processOrder('PO-SMALL');
  const spare=await engine.presentOrder('PO-SPARE');
  show({small:lineSummary(small[0]),spareReserved:spare.reserved,spareActual:spare.actual});

  heading('场景 5：发送后崩溃，重启只查单不重买');
  source.state.dropResponse=true;
  orderLookups.fail=true;
  await engine.defineOrder({id:'PO-CRASH',purpose:'授信评估',version:1,budget:20,deadline});
  const {line:crashed}=await engine.enqueue({orderId:'PO-CRASH',entityKey:'enterprise-7'});
  await engine.processLine(crashed.id);
  show({beforeRestart:lineSummary(engine.presentLine(crashed.id)),purchasePosts,sourceOrders:Object.keys(source.state.orders).length});
  orderLookups.fail=false;
  const reopened=await AcquisitionEngine.open({...options,ledgerPath});
  const recovered=await reopened.recover();
  show({
    recovered:recovered.map(lineSummary),
    purchasePosts,
    sourceOrders:Object.keys(source.state.orders).length,
    note:'恢复过程只调用 GET /orders/:requestId，没有新的 POST /purchase'
  });
  source.state.dropResponse=false;

  heading('场景 6：披露复用（同用途同版本未过期）');
  await reopened.defineOrder({id:'PO-REUSE',purpose:'授信评估',version:1,budget:20,deadline});
  await reopened.enqueue({orderId:'PO-REUSE',entityKey:'enterprise-3'});
  const [reused]=await reopened.processOrder('PO-REUSE');
  await reopened.defineOrder({id:'PO-OTHER',purpose:'市场分析',version:1,budget:20,deadline});
  await reopened.enqueue({orderId:'PO-OTHER',entityKey:'enterprise-3'});
  const [otherPurpose]=await reopened.processOrder('PO-OTHER');
  show({samePurpose:{...lineSummary(reused),reused:reused.reused,reusedFrom:reused.reusedFrom},differentPurpose:lineSummary(otherPurpose),sourceOrders:Object.keys(source.state.orders).length});

  heading('对账报表');
  const report=reopened.report();
  const orders=report.orders.map(order=>({
    id:order.id,
    status:order.status,
    budget:order.budget,
    reserved:order.reserved,
    actual:order.actual,
    released:order.released,
    unknownAmount:order.unknownAmount,
    overage:order.overage,
    available:order.available,
    lines:order.lines.map(lineSummary)
  }));
  show({totals:report.totals,orders});

  heading('披露记录与原始资料摘要');
  show({disclosures:report.disclosures.map(disclosure=>({
    id:disclosure.id,
    orderId:disclosure.orderId,
    purpose:disclosure.purpose,
    version:disclosure.version,
    charged:disclosure.charged,
    status:disclosure.status,
    retrievedAt:disclosure.retrievedAt,
    expiresAt:disclosure.expiresAt,
    resultSha256:disclosure.resultSha256
  }))});

  heading('人工处理审计记录');
  show(reopened.events().filter(event=>event.type==='line.manual_resolution').map(event=>({
    type:event.type,
    orderId:event.orderId,
    lineId:event.lineId,
    outcome:event.outcome,
    operator:event.operator,
    evidence:event.evidence
  })));

  console.log(`\n账本：${ledgerPath}`);
  console.log((await readFile(ledgerPath,'utf8')).slice(0,300)+'…');
}finally{
  await source.close();
  await rm(directory,{recursive:true,force:true});
}
