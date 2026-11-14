import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AcquisitionEngine} from '../src/engine.mjs';
import {createSource} from '../src/source.mjs';

/** A temp ledger directory plus factory functions bound to one local source. */
export async function makeHarness(t,{fixture,now=Date.now(),clock:given}={}){
  const directory=await mkdtemp(join(tmpdir(),'acquisition-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=await createSource(fixture?{fixture}:undefined);
  t.after(()=>source.close());
  const ledgerPath=join(directory,'ledger.json');

  let current=now;
  const clock=given??(()=>current);
  if(!given)clock.advance=ms=>{current+=ms;};

  const open=(options={})=>AcquisitionEngine.open({sourceUrl:source.url,ledgerPath,clock,...options});

  return {
    directory,
    ledgerPath,
    source,
    clock,
    open,
    deadline:(offset=8*60*60*1000)=>new Date((clock.now?clock.now():clock())+offset).toISOString()
  };
}

export function sourceApi(source){
  return async(path,{method='GET',body}={})=>{
    const response=await fetch(source.url+path,{
      method,
      headers:body===undefined?undefined:{'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),
      signal:AbortSignal.timeout(4000)
    });
    const text=await response.text();
    let value=text;
    try{value=JSON.parse(text);}catch{}
    return {status:response.status,value};
  };
}

/** Fetch wrapper whose supplier order lookup can be made to fail on demand. */
export function flakyFetch(state){
  return async(url,options)=>{
    if(state.ordersFail&&String(url).includes('/orders/'))throw new TypeError('模拟查单网络中断');
    return globalThis.fetch(url,options);
  };
}

export async function ledgerFile(ledgerPath){
  return JSON.parse(await (await import('node:fs/promises')).readFile(ledgerPath,'utf8'));
}
