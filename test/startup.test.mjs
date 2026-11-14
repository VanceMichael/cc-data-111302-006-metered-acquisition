import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

async function freePort(){
  const reservation=net.createServer();
  reservation.listen(0,'127.0.0.1');
  await once(reservation,'listening');
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  return port;
}

async function waitForOutput(child,getOutput,pattern,timeout=6000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    assert.equal(child.exitCode,null,getOutput());
    if(pattern.test(getOutput()))return;
    await delay(25);
  }
  throw new Error(`等待输出超时: ${getOutput()}`);
}

function startChild(env){
  const child=spawn(process.execPath,['src/serve.mjs'],{
    cwd:new URL('..',import.meta.url),
    env:{...process.env,...env},
    stdio:['ignore','pipe','pipe']
  });
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk.toString();});
  child.stderr.on('data',chunk=>{output+=chunk.toString();});
  return {child,output:()=>output,ready:()=>{
    const line=output.trim().split('\n').findLast(candidate=>candidate.startsWith('{'));
    return line?JSON.parse(line):null;
  }};
}

async function waitForReady(running,timeout=6000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    assert.equal(running.child.exitCode,null,running.output());
    const ready=running.ready();
    if(ready)return ready;
    await delay(25);
  }
  throw new Error(`等待就绪超时: ${running.output()}`);
}

test('启动入口遵循指定的监听端口', {timeout:8000}, async ()=>{
  const port=await freePort();
  const directory=await mkdtemp(join(tmpdir(),'acquisition-startup-'));
  const running=startChild({HOST:'127.0.0.1',PORT:String(port),CONSOLE_PORT:'0',LEDGER_PATH:join(directory,'ledger.json')});
  try{
    let health;
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      assert.equal(running.child.exitCode,null,running.output());
      try{
        const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)});
        if(response.ok){health=await response.json();break;}
      }catch{}
      await delay(25);
    }
    assert.equal(health?.status,'ok',running.output());
    const ready=await waitForReady(running);
    assert.equal(ready.source,`http://127.0.0.1:${port}`);
    assert.match(ready.console,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(JSON.parse(await readFile(ready.ledger,'utf8')).schema,1);
    const report=await fetch(ready.console+'/report').then(response=>response.json());
    assert.deepEqual(report.totals,{budget:0,reserved:0,actual:0,released:0,unknownAmount:0,overage:0});
  }finally{
    if(running.child.exitCode===null){
      running.child.kill('SIGTERM');
      await once(running.child,'exit');
    }
    await rm(directory,{recursive:true,force:true});
  }
});

test('重启时对账台先查单恢复未决领取，不新增购买', {timeout:10000}, async ()=>{
  const directory=await mkdtemp(join(tmpdir(),'acquisition-restart-'));
  const port=await freePort();
  const ledgerPath=join(directory,'ledger.json');
  const {createSource}=await import('../src/source.mjs');
  const {LedgerStore}=await import('../src/store.mjs');
  const source=await createSource();
  let recoveredOrderExists=false;
  try{
    // Seed a ledger as if the previous process died right after persisting the
    // send marker but before any HTTP call reached the supplier.
    const store=new LedgerStore(ledgerPath);
    await store.load();
    const deadline=new Date(Date.now()+3600000).toISOString();
    await store.update(draft=>{
      draft.orders['PO-1']={id:'PO-1',purpose:'授信评估',version:1,budget:10,deadline,status:'active',cancelledAt:null,createdAt:deadline,lines:['line-1']};
      draft.lines['line-1']={
        id:'line-1',orderId:'PO-1',entityKey:'enterprise-1',requestId:'req-restart',
        phase:'sending',reserved:3,actual:0,released:0,quote:{price:3,datasetVersion:1},maxPrice:3,
        quoteRetries:0,disclosureId:null,reusedFrom:null,result:null,attempts:[],
        lastError:null,cancelRequested:false,cancelledAt:null,createdAt:deadline,updatedAt:deadline
      };
    });

    // Starting the console against a supplier that never saw this request must
    // reconcile the line to released, not re-purchase.
    const {startServer}=await import('../src/console.mjs');
    const server=await startServer({sourceUrl:source.url,ledgerPath});
    try{
      const report=await fetch(server.url+'/report').then(response=>response.json());
      const line=report.orders[0].lines[0];
      assert.equal(line.phase,'released');
      assert.equal(line.actual,0);
      assert.equal(line.released,3);
      assert.equal(Object.keys(source.state.orders).length,0);
      assert.equal(report.orders[0].actual,0);
    }finally{
      await server.close();
    }

    const child=startChild({HOST:'127.0.0.1',PORT:String(port),CONSOLE_PORT:'0',LEDGER_PATH:ledgerPath});
    try{
      const ready=await waitForReady(child);
      const report=await fetch(ready.console+'/report').then(response=>response.json());
      assert.equal(report.orders[0].lines[0].phase,'released');
      assert.equal(Object.keys(source.state.orders).length,0);
      recoveredOrderExists=true;
    }finally{
      if(child.child.exitCode===null){
        child.child.kill('SIGTERM');
        await once(child.child,'exit');
      }
    }
    const reopened=await new LedgerStore(ledgerPath).load();
    assert.ok(reopened.orders['PO-1']);
    assert.equal(reopened.lines['line-1'].phase,'released');
  }finally{
    assert.equal(recoveredOrderExists,true);
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});

