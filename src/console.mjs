import {createServer as createHttpServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {AcquisitionEngine} from './engine.mjs';

const MAX_BODY=1024*1024;
const STATUS_BY_CODE={
  INVALID_INPUT:400,
  ORDER_NOT_FOUND:404,
  LINE_NOT_FOUND:404,
  ORDER_CONFLICT:409,
  ORDER_CANCELLED:409,
  ORDER_DEADLINE_PASSED:409,
  LINE_NOT_UNKNOWN:409
};

function send(response,value,status=200){
  if(response.headersSent)return response.destroy();
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  response.end(JSON.stringify(value));
}

async function readJson(request){
  let text='';
  for await(const chunk of request){
    text+=chunk;
    if(text.length>MAX_BODY)throw Object.assign(new Error('请求体过大'),{status:413});
  }
  if(!text)return {};
  try{return JSON.parse(text);}catch{throw Object.assign(new Error('JSON无效'),{status:400});}
}

/**
 * Local operator API for the acquisition worker. `sourceUrl` must be a local
 * synthetic supplier; the engine's client refuses non-loopback addresses.
 */
export async function startServer({port=0,host='127.0.0.1',ledgerPath,sourceUrl,engineOptions={},clock,recoverOnStart=true}={}){
  const engine=await AcquisitionEngine.open({...engineOptions,sourceUrl,ledgerPath,clock});
  let recovered=[];
  if(recoverOnStart){
    // A previous process may have died between persisting a send marker and
    // recording the outcome. Resolve those lines by requestId before serving;
    // this never issues a new purchase.
    try{recovered=await engine.recover();}catch{}
  }
  const server=createHttpServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');
      const method=request.method;
      if(url.pathname==='/health')return send(response,{status:'ok',ledger:engine.ledgerPath});
      if(url.pathname==='/report'&&method==='GET')return send(response,engine.report());
      if(url.pathname==='/events'&&method==='GET')return send(response,engine.events());
      if(url.pathname==='/orders'&&method==='POST'){
        return send(response,await engine.defineOrder(await readJson(request)),201);
      }
      const orderMatch=/^\/orders\/([^/]+)$/.exec(url.pathname);
      if(orderMatch&&method==='GET')return send(response,engine.presentOrder(decodeURIComponent(orderMatch[1])));
      const enqueueMatch=/^\/orders\/([^/]+)\/lines$/.exec(url.pathname);
      if(enqueueMatch&&method==='POST'){
        const body=await readJson(request);
        return send(response,await engine.enqueue({orderId:decodeURIComponent(enqueueMatch[1]),entityKey:body.entityKey}),201);
      }
      const processMatch=/^\/orders\/([^/]+)\/process$/.exec(url.pathname);
      if(processMatch&&method==='POST'){
        const body=await readJson(request);
        return send(response,{lines:await engine.processOrder(decodeURIComponent(processMatch[1]),{lineIds:body.lineIds})});
      }
      const cancelMatch=/^\/orders\/([^/]+)\/cancel$/.exec(url.pathname);
      if(cancelMatch&&method==='POST'){
        const body=await readJson(request);
        return send(response,await engine.cancelOrder(decodeURIComponent(cancelMatch[1]),{reason:body.reason,actor:body.actor}));
      }
      if(url.pathname==='/recover'&&method==='POST')return send(response,{lines:await engine.recover()});
      const lineMatch=/^\/lines\/([^/]+)$/.exec(url.pathname);
      if(lineMatch&&method==='GET')return send(response,engine.presentLine(decodeURIComponent(lineMatch[1])));
      const lineProcessMatch=/^\/lines\/([^/]+)\/process$/.exec(url.pathname);
      if(lineProcessMatch&&method==='POST')return send(response,await engine.processLine(decodeURIComponent(lineProcessMatch[1])));
      const manualMatch=/^\/lines\/([^/]+)\/resolve$/.exec(url.pathname);
      if(manualMatch&&method==='POST'){
        const body=await readJson(request);
        return send(response,await engine.resolveUnknown({...body,lineId:decodeURIComponent(manualMatch[1])}));
      }
      if(url.pathname==='/'&&method==='GET'){
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        return response.end(await readFile(new URL('../docs/console.html',import.meta.url)));
      }
      return send(response,{error:'资源不存在'},404);
    }catch(error){
      const status=error.status??STATUS_BY_CODE[error.code]??500;
      return send(response,{error:error.message,code:error.code??null,details:error.details??null},status);
    }
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {
    url:`http://127.0.0.1:${server.address().port}`,
    engine,
    recovered,
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  };
}
