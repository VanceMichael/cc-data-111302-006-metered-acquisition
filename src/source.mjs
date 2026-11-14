import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}

const CONTROL_FIELDS=new Set(['price','pending','dropResponse','datasetVersion','complete']);

function recordFor(order){
  // Content depends only on the data version, so two disclosures for the same
  // version have identical content even when their authorized purpose differs.
  const hash=createHash('sha256').update(`enterprise-${order.version}`).digest('hex').slice(0,16);
  return {
    id:`enterprise-${order.version}`,
    name:'合成企业',
    version:order.version,
    digest:hash,
    text:`合成资料 v${order.version}。\n本内容仅用于本地合成供应商测试，不含真实个人或企业信息。`
  };
}

export async function createSource({port=0,host='127.0.0.1',fixture}={}){
  const state=fixture?structuredClone(fixture):JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));

  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');let text='';
      for await(const chunk of request){text+=chunk;if(text.length>8*1024*1024){json(response,{error:'控制请求过大'},413);return;}}
      let body={};if(text){try{body=JSON.parse(text);}catch{return json(response,{error:'JSON无效'},400);}}
      if(url.pathname==='/health')return json(response,{status:'ok'});
      if(url.pathname==='/state'||url.pathname==='/inventory')return json(response,state);
      if(url.pathname==='/quote')return json(response,{price:state.price,datasetVersion:state.datasetVersion});
      if(url.pathname==='/control'&&request.method==='POST'){
        const unknown=Object.keys(body).filter(key=>!CONTROL_FIELDS.has(key));
        if(unknown.length)return json(response,{error:`不支持的来源控制字段: ${unknown.join(', ')}`},400);
        if(Object.hasOwn(body,'price')&&(!Number.isInteger(body.price)||body.price<0))return json(response,{error:'报价必须是非负整数'},400);
        if(Object.hasOwn(body,'pending')&&typeof body.pending!=='boolean')return json(response,{error:'pending 必须是布尔值'},400);
        if(Object.hasOwn(body,'dropResponse')&&typeof body.dropResponse!=='boolean')return json(response,{error:'dropResponse 必须是布尔值'},400);
        if(Object.hasOwn(body,'datasetVersion')&&(!Number.isInteger(body.datasetVersion)||body.datasetVersion<1))return json(response,{error:'资料版本必须是正整数'},400);
        if(Object.hasOwn(body,'complete')&&typeof body.complete!=='boolean')return json(response,{error:'complete 必须是布尔值'},400);
        if(body.complete)for(const order of Object.values(state.orders))order.status='ready';
        const {complete,...rest}=body;
        Object.assign(state,rest);
        return json(response,state);
      }

      if(url.pathname==='/purchase'&&request.method==='POST'){
        if(!body.requestId||!body.purpose)return json(response,{error:'缺少披露身份'},400);
        if(!Number.isInteger(body.version))return json(response,{error:'缺少资料版本'},400);
        if(body.maxPrice!==undefined&&(!Number.isInteger(body.maxPrice)||body.maxPrice<0))return json(response,{error:'最高价必须是非负整数'},400);
        let order=state.orders[body.requestId];
        if(order&&(order.purpose!==body.purpose||order.version!==body.version))return json(response,{error:'披露冲突'},409);
        if(!order){
          if(!Number.isInteger(body.maxPrice)||body.maxPrice<state.price)return json(response,{error:'报价超出授权上限',price:state.price},402);
          order={id:body.requestId,purpose:body.purpose,version:body.version,charged:state.price,status:state.pending?'charged_waiting':'ready',at:new Date().toISOString()};
          state.orders[order.id]=order;
        }
        // Simulates a charged disclosure whose HTTP response is lost. A retry
        // with the same requestId still finds the original disclosure fact.
        if(state.dropResponse)return response.destroy();
        return json(response,order);
      }
      if(url.pathname.startsWith('/orders/')){
        const order=state.orders[url.pathname.split('/').pop()];
        return json(response,order||{error:'未受理'},order?200:404);
      }
      if(url.pathname.startsWith('/results/')){
        const order=state.orders[url.pathname.split('/').pop()];
        if(!order||order.status!=='ready')return json(response,{error:'未就绪'},409);
        return json(response,{order:order.id,version:order.version,purpose:order.purpose,records:[recordFor(order)]});
      }

      return json(response,{error:'资源不存在'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},500);else response.destroy();}
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
