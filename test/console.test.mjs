import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../src/console.mjs';
import {makeHarness} from './helpers.mjs';

async function start(t){
  const harness=await makeHarness(t,{fixture:{price:3,orders:{},dropResponse:false,pending:true,datasetVersion:1}});
  const server=await startServer({sourceUrl:harness.source.url,ledgerPath:harness.ledgerPath});
  t.after(()=>server.close());
  const call=async(path,method='GET',body)=>{
    const response=await fetch(server.url+path,{
      method,
      headers:body===undefined?undefined:{'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)
    });
    const text=await response.text();
    let value=text;
    try{value=JSON.parse(text);}catch{}
    return {status:response.status,value};
  };
  return {harness,server,call};
}

test('控制台暴露采购单明细、披露记录与取消记录', async t=>{
  const {call,server}=await start(t);
  const deadline=new Date(Date.now()+60*60*1000).toISOString();
  assert.equal((await call('/orders','POST',{id:'PO-1',purpose:'授信评估',version:1,budget:30,deadline})).status,201);
  assert.equal((await call('/orders/PO-1/lines','POST',{entityKey:'ent-1'})).status,201);
  const processed=await call('/orders/PO-1/process','POST',{});
  assert.equal(processed.value.lines[0].phase,'charged_waiting');

  const report=await call('/report');
  assert.equal(report.value.orders[0].actual,3);
  assert.equal(report.value.orders[0].reserved,0);
  assert.equal(report.value.disclosures.length,1);
  assert.equal(report.value.disclosures[0].status,'charged_waiting');
  assert.equal(report.value.disclosures[0].charged,3);
  assert.equal(report.value.unknown.length,0);

  assert.equal((await call('/orders/PO-1/cancel','POST',{reason:'部门取消',actor:'ops'})).value.status,'cancelled');
  assert.ok((await call('/events')).value.some(event=>event.type==='order.cancelled'));

  assert.equal((await call('/orders/missing/lines','POST',{entityKey:'x'})).status,404);
  assert.equal((await call('/lines/missing')).status,404);
  assert.equal((await call('/nope')).status,404);

  const page=await fetch(server.url+'/');
  assert.equal(page.status,200);
  assert.match(await page.text(),/采购单对账台/);
});

test('健康检查复用同一账本', async t=>{
  const {call}=await start(t);
  const health=await call('/health');
  assert.equal(health.status,200);
  assert.equal(health.value.status,'ok');
});
