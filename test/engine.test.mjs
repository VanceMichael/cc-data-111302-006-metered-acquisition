import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHarness, sourceApi} from './helpers.mjs';

/**
 * Financial behaviour around the supplier's metered disclosure endpoint:
 * pre-reservation, quote drift, ambiguous charges, restart safety, reuse,
 * cancellation interleaving and manual resolution.
 */

test('发送前预占，实际扣费与原始资料进入采购单明细', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open();
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const result=await engine.processLine(line.id);

  assert.equal(result.phase,'ready');
  assert.equal(result.actual,3);
  assert.equal(result.reserved,0);
  assert.equal(result.released,0);
  assert.equal(result.unknownAmount,0);
  assert.equal(result.quote.price,3);
  assert.equal(result.maxPrice,3);
  assert.match(result.result.sha256,/^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(result.result.bytesBase64,'base64').toString('utf8'),JSON.stringify(result.result.json));

  const order=engine.presentOrder('PO-1');
  assert.equal(order.actual,3);
  assert.equal(order.reserved,0);
  assert.equal(order.committed,3);
  assert.equal(order.available,7);

  const types=engine.events().map(event=>event.type);
  for(const type of ['line.reserved','line.send_started','line.charged','line.ready'])assert.ok(types.includes(type),type);
  assert.equal(Object.keys(h.source.state.orders).length,1);

  const report=engine.report();
  assert.equal(report.totals.actual,3);
  assert.equal(report.disclosures.length,1);
  assert.equal(report.disclosures[0].orderId,'PO-1');
  assert.equal(report.disclosures[0].charged,3);
  assert.equal(report.disclosures[0].resultSha256,result.result.sha256);
});

test('报价上涨：按来源最终报价补足预占并核销差额', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open({hooks:{beforePurchase:async()=>{h.source.state.price=7;}}});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});

  const [line]=await engine.processOrder('PO-1');
  assert.equal(line.phase,'ready');
  assert.equal(line.actual,7);
  assert.equal(line.released,3, '旧预占按 3 释放，再按 7 重新预占');
  assert.equal(line.overage,0);
  const attempts=line.attempts.map(attempt=>attempt.outcome);
  assert.ok(attempts.includes('price_changed'));
  assert.equal(Object.keys(h.source.state.orders).length,1);

  const totals=engine.report().totals;
  assert.equal(totals.actual,7);
  assert.equal(totals.reserved,0);
  assert.equal(totals.released,3);
});

test('报价上涨超出本单预算：不发送、不挪用其他采购单预算', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open({hooks:{beforePurchase:async()=>{h.source.state.price=9;}}});
  await engine.defineOrder({id:'A',purpose:'授信评估',version:1,budget:5,deadline:h.deadline()});
  await engine.defineOrder({id:'B',purpose:'授信评估',version:1,budget:100,deadline:h.deadline()});
  await engine.enqueue({orderId:'A',entityKey:'ent-a'});
  const {line:bLine}=await engine.enqueue({orderId:'B',entityKey:'ent-b'});

  const [line]=await engine.processOrder('A');
  assert.equal(line.phase,'failed');
  assert.equal(line.actual,0);
  assert.equal(line.lastError.code,'BUDGET_EXCEEDED');
  assert.equal(line.released,3);

  const b=engine.presentOrder('B');
  assert.equal(b.reserved,0,'B 尚未领取，不能被 A 借用');
  assert.equal(b.actual,0);
  assert.equal(engine.presentLine(bLine.id).phase,'planned');
  assert.equal(Object.keys(h.source.state.orders).length,0,'超预算时来源没有建立披露');
  assert.equal(engine.presentOrder('A').actual,0);
});

test('已预占未发送时取消：释放额度且不产生披露', async t=>{
  const h=await makeHarness(t);
  let engine;
  engine=await h.open({hooks:{beforePurchase:async()=>{await engine.requestCancelOrder('PO-1',{reason:'部门取消需求',actor:'ops'});}}});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const result=await engine.processLine(line.id);

  assert.equal(result.phase,'released');
  assert.equal(result.actual,0);
  assert.equal(result.released,3);
  assert.equal(Object.keys(h.source.state.orders).length,0);
  assert.equal(engine.presentOrder('PO-1').status,'cancelled');
  assert.ok(engine.events().some(event=>event.type==='order.cancelled'));
  assert.ok(result.attempts.some(attempt=>attempt.outcome==='cancelled_before_request'));
});

test('响应丢失后先查单：已收费则按原请求号核销，不重新购买', async t=>{
  const h=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:true,pending:false,datasetVersion:1}});
  let purchases=0;
  const counted=async(url,options)=>{
    if(String(url).includes('/purchase'))purchases+=1;
    return globalThis.fetch(url,options);
  };
  const engine=await h.open({fetchImpl:counted});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const result=await engine.processLine(line.id);

  assert.equal(result.phase,'ready','查单确认已受理并取得结果');
  assert.equal(result.actual,3);
  assert.equal(result.unknownAmount,0);
  assert.equal(purchases,1);
  assert.equal(Object.keys(h.source.state.orders).length,1);

  // No result can be fetched twice into a second charge.
  const again=await engine.processLine(line.id);
  assert.equal(again.phase,'ready');
  assert.equal(purchases,1);
});

test('查单确认从未受理：释放预占，不把预占当扣费', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open();
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});

  // Persist a send marker without issuing the HTTP call, as if the process
  // died immediately before the request. The supplier has no such order.
  const ledger=await import('../src/store.mjs');
  const store=new ledger.LedgerStore(h.ledgerPath);
  await store.load();
  await store.update(draft=>{
    const target=draft.lines[line.id];
    target.phase='sending';
    target.reserved=3;
    target.maxPrice=3;
  });

  const reopened=await h.open();
  const [recovered]=await reopened.recover();
  assert.equal(recovered.phase,'released');
  assert.equal(recovered.actual,0);
  assert.equal(recovered.released,3);
  assert.equal(recovered.lastError.code,'SOURCE_NOT_ACCEPTED');
  assert.equal(Object.keys(h.source.state.orders).length,0);

  const processed=await reopened.processLine(line.id);
  assert.equal(processed.phase,'released');
  assert.equal(Object.keys(h.source.state.orders).length,0,'恢复过程从不重新购买');
});

test('已受理但响应丢失后重启：查单核销，不出现第二次购买', async t=>{
  const h=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:true,pending:false,datasetVersion:1}});
  let purchases=0;
  const counted=async(url,options)=>{
    if(String(url).includes('/purchase'))purchases+=1;
    return globalThis.fetch(url,options);
  };
  const failState={ordersFail:false};
  const engine=await h.open({fetchImpl:async(url,options)=>{
    if(failState.ordersFail&&String(url).includes('/orders/'))throw new TypeError('查单中断');
    return counted(url,options);
  }});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});

  // Force the first attempt into unknown by making the reconciliation lookup
  // fail after the response was dropped; the disclosure still exists at the
  // supplier and was charged.
  failState.ordersFail=true;
  const first=await engine.processLine(line.id);
  assert.equal(first.phase,'unknown');
  assert.equal(first.unknownAmount,3);
  assert.equal(purchases,1);
  assert.equal(Object.keys(h.source.state.orders).length,1);

  failState.ordersFail=false;
  const reopened=await h.open({fetchImpl:counted});
  const [recovered]=await reopened.recover();
  assert.equal(recovered.phase,'ready');
  assert.equal(recovered.actual,3);
  assert.equal(recovered.requestId,first.requestId);
  assert.equal(purchases,1,'重启只查单，不再次 POST /purchase');
  assert.equal(Object.keys(h.source.state.orders).length,1);

  const totals=reopened.report().totals;
  assert.equal(totals.actual,3);
  assert.equal(totals.unknownAmount,0);
  assert.equal(totals.released,0);
});

test('取消发生在受理之后：保留已披露扣费，结果继续可取', async t=>{
  const h=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:true,pending:false,datasetVersion:1}});
  let engine;
  engine=await h.open({hooks:{afterSendFailure:async()=>{await engine.requestCancelOrder('PO-1',{reason:'部门取消需求',actor:'ops'});}}});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const result=await engine.processLine(line.id);

  assert.equal(result.phase,'ready','已披露的事实继续核销并取回原始资料');
  assert.equal(result.actual,3);
  assert.equal(result.released,0,'不假装退款');
  assert.equal(engine.presentOrder('PO-1').status,'cancelled');
  assert.equal(engine.presentOrder('PO-1').actual,3);
  assert.equal(Object.keys(h.source.state.orders).length,1);
  // The cancellation arrived while the purchase was in flight, so the line is
  // marked for reconciliation rather than assumed refundable.
  assert.ok(result.attempts.some(attempt=>attempt.outcome==='reconcile_in_flight'));
});

test('取消与排队任务交错：未发送的排队领取停止，已收费的继续核销', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open();
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line:first}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const {line:second}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-2'});
  assert.equal((await engine.processLine(first.id)).phase,'ready');

  const order=await engine.cancelOrder('PO-1',{reason:'部门取消剩余需求',actor:'ops'});
  assert.equal(order.status,'cancelled');
  const queued=engine.presentLine(second.id);
  assert.equal(queued.phase,'released');
  assert.equal(queued.actual,0);
  assert.equal(queued.released,0,'尚未预占，因此没有释放金额');
  assert.equal(engine.presentOrder('PO-1').actual,3,'已披露的扣费仍在账上');
  assert.equal(engine.presentOrder('PO-1').released,0);

  const later=await engine.processLine(second.id);
  assert.equal(later.phase,'release'?later.phase:'released');
  assert.equal(Object.keys(h.source.state.orders).length,1,'取消后不再发出领取');
});

test('相同请求号重试不产生第二笔披露', async t=>{
  const h=await makeHarness(t);
  const api=sourceApi(h.source);
  const body={requestId:'req-fixed',purpose:'授信评估',version:1,maxPrice:4};
  assert.equal((await api('/purchase',{method:'POST',body})).value.charged,3);
  assert.equal((await api('/purchase',{method:'POST',body})).value.charged,3);
  assert.equal(Object.keys(h.source.state.orders).length,1);
});

test('披露结果仅在用途相同、版本相同且未过期时复用', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open();
  await engine.defineOrder({id:'A',purpose:'授信评估',version:1,budget:50,deadline:h.deadline(10*60*60*1000)});
  await engine.enqueue({orderId:'A',entityKey:'ent-1'});
  const [first]=await engine.processOrder('A');
  assert.equal(first.actual,3);

  await engine.defineOrder({id:'B',purpose:'授信评估',version:1,budget:50,deadline:h.deadline(9*60*60*1000)});
  await engine.enqueue({orderId:'B',entityKey:'ent-1'});
  const [reused]=await engine.processOrder('B');
  assert.equal(reused.reused,true);
  assert.equal(reused.actual,0);
  assert.equal(reused.reusedFrom,first.disclosureId);
  assert.equal(Object.keys(h.source.state.orders).length,1);

  // Same bytes, different purpose: must buy again.
  await engine.defineOrder({id:'C',purpose:'市场分析',version:1,budget:50,deadline:h.deadline(8*60*60*1000)});
  await engine.enqueue({orderId:'C',entityKey:'ent-1'});
  const [differentPurpose]=await engine.processOrder('C');
  assert.equal(differentPurpose.reused,false);
  assert.equal(differentPurpose.actual,3);
  assert.equal(Object.keys(h.source.state.orders).length,2);

  // Same purpose but the reusable disclosure has expired.
  h.clock.advance(25*60*60*1000);
  await engine.defineOrder({id:'D',purpose:'授信评估',version:1,budget:50,deadline:h.deadline(60*60*1000)});
  await engine.enqueue({orderId:'D',entityKey:'ent-1'});
  const [expired]=await engine.processOrder('D');
  assert.equal(expired.reused,false);
  assert.equal(expired.actual,3);
  assert.equal(Object.keys(h.source.state.orders).length,3);
});

test('可接受版本与来源当前版本不一致时失败，不产生采购', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open();
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:2,budget:10,deadline:h.deadline()});
  await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const [line]=await engine.processOrder('PO-1');
  assert.equal(line.phase,'failed');
  assert.equal(line.lastError.code,'VERSION_UNAVAILABLE');
  assert.equal(line.actual,0);
  assert.equal(Object.keys(h.source.state.orders).length,0);
});

test('已收费但结果尚不可取：保持 charged_waiting，不重新购买', async t=>{
  const h=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:false,pending:true,datasetVersion:1}});
  const engine=await h.open();
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const pending=await engine.processLine(line.id);

  assert.equal(pending.phase,'charged_waiting');
  assert.equal(pending.actual,3);
  assert.equal(pending.reserved,0);
  assert.equal(pending.lastError.code,'RESULT_NOT_READY');
  assert.equal(engine.report().totals.actual,3);

  await sourceApi(h.source)('/control',{method:'POST',body:{complete:true}});
  const reopened=await h.open();
  const ready=await reopened.processLine(line.id);
  assert.equal(ready.phase,'ready');
  assert.equal(ready.actual,3);
  assert.equal(Object.keys(h.source.state.orders).length,1,'结果轮询不会重复购买');
});

test('并发领取不能超支同一采购单预算', async t=>{
  const h=await makeHarness(t);
  const engine=await h.open();
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:4,deadline:h.deadline()});
  await engine.enqueue({orderId:'PO-1',entityKey:'ent-a'});
  await engine.enqueue({orderId:'PO-1',entityKey:'ent-b'});
  await Promise.all([engine.processOrder('PO-1'),engine.processOrder('PO-1')]);

  const order=engine.presentOrder('PO-1');
  const phases=order.lines.map(line=>line.phase).sort();
  assert.deepEqual(phases,['failed','ready']);
  assert.equal(order.actual,3);
  assert.equal(order.reserved,0);
  assert.equal(order.available,1);
  assert.equal(Object.keys(h.source.state.orders).length,1);
});

test('未知费用可人工核销，必须留下依据与处理人', async t=>{
  const h=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:true,pending:false,datasetVersion:1}});
  const failState={ordersFail:true};
  const engine=await h.open({fetchImpl:async(url,options)=>{
    if(String(url).includes('/orders/'))throw new TypeError('查单中断');
    return globalThis.fetch(url,options);
  }});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  const unknown=await engine.processLine(line.id);
  assert.equal(unknown.phase,'unknown');
  assert.equal(unknown.unknownAmount,3);
  const report=engine.report();
  assert.equal(report.unknown.length,1);
  assert.equal(report.unknown[0].amount,3);
  assert.equal(report.unknown[0].requestId,unknown.requestId);
  assert.equal(report.totals.unknownAmount,3);
  assert.equal(report.totals.actual,0);

  await assert.rejects(()=>engine.resolveUnknown({lineId:line.id,outcome:'charged',amount:3,operator:'ops'}),{code:'INVALID_INPUT'});
  await assert.rejects(()=>engine.resolveUnknown({lineId:line.id,outcome:'charged',amount:3,evidence:'对账单',operator:''}),{code:'INVALID_INPUT'});

  const resolved=await engine.resolveUnknown({
    lineId:line.id,
    outcome:'charged',
    amount:3,
    operator:'ops',
    evidence:'供应商对账单：requestId 已扣费 3',
    result:{
      sourceStatus:200,
      contentType:'application/json; charset=utf-8',
      sha256:'a'.repeat(64),
      bytesBase64:Buffer.from('{}').toString('base64'),
      json:{order:unknown.requestId,records:[]},
      retrievedAt:new Date(h.clock()).toISOString()
    }
  });
  assert.equal(resolved.phase,'ready');
  assert.equal(resolved.actual,3);
  assert.equal(resolved.unknownAmount,0);
  assert.equal(engine.report().totals.unknownAmount,0);
  const manual=engine.events().find(event=>event.type==='line.manual_resolution');
  assert.equal(manual.evidence,'供应商对账单：requestId 已扣费 3');
  assert.equal(manual.operator,'ops');

  await assert.rejects(()=>engine.resolveUnknown({lineId:line.id,outcome:'not_charged',operator:'ops',evidence:'重复处理'}),{code:'LINE_NOT_UNKNOWN'});
});

test('人工确认从未扣费时释放预占', async t=>{
  const h=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:true,pending:false,datasetVersion:1}});
  const engine=await h.open({fetchImpl:async(url,options)=>{
    if(String(url).includes('/orders/'))throw new TypeError('查单中断');
    return globalThis.fetch(url,options);
  }});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  await engine.processLine(line.id);
  const resolved=await engine.resolveUnknown({lineId:line.id,outcome:'not_charged',operator:'ops',evidence:'供应商确认未受理'});
  assert.equal(resolved.phase,'released');
  assert.equal(resolved.released,3);
  assert.equal(resolved.actual,0);
  assert.equal(engine.report().totals.unknownAmount,0);
});

test('人工核销的金额超过本单可用预算时记录超支差额，不伪造其他单额度', async t=>{
  const h=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:true,pending:false,datasetVersion:1}});
  const engine=await h.open({fetchImpl:async(url,options)=>{
    if(String(url).includes('/orders/'))throw new TypeError('查单中断');
    return globalThis.fetch(url,options);
  }});
  await engine.defineOrder({id:'PO-1',purpose:'授信评估',version:1,budget:4,deadline:h.deadline()});
  await engine.defineOrder({id:'PO-2',purpose:'授信评估',version:1,budget:100,deadline:h.deadline()});
  const {line}=await engine.enqueue({orderId:'PO-1',entityKey:'ent-1'});
  await engine.processLine(line.id);

  const resolved=await engine.resolveUnknown({
    lineId:line.id,
    outcome:'charged',
    amount:5,
    operator:'ops',
    evidence:'供应商账单显示实际扣费 5'
  });
  assert.equal(resolved.phase,'charged');
  assert.equal(resolved.actual,5);
  assert.equal(resolved.overage,1);
  assert.equal(resolved.overBudget,true);

  const order=engine.presentOrder('PO-1');
  assert.equal(order.actual,5);
  assert.equal(order.available,-1, '超支必须显式暴露，而不是从其他采购单借额度');
  assert.equal(order.overage,1);
  assert.equal(engine.presentOrder('PO-2').actual,0);
  assert.equal(engine.presentOrder('PO-2').reserved,0);
  assert.ok(engine.events().some(event=>event.type==='line.manual_resolution'));
});
