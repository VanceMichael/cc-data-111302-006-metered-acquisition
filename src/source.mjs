import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export function json(response,value,status=200){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(value));}
export async function createSource({port=0,host='127.0.0.1'}={}){
  const state=JSON.parse(await readFile(new URL('../fixtures/source.json',import.meta.url),'utf8'));
  
  const pages={};
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://local.test');let text='';
      for await(const chunk of request){text+=chunk;if(text.length>8*1024*1024){json(response,{error:'控制请求过大'},413);return;}}
      let body={};if(text){try{body=JSON.parse(text);}catch{return json(response,{error:'JSON无效'},400);}}
      if(url.pathname==='/health')return json(response,{status:'ok'});
      if(url.pathname==='/state'||url.pathname==='/inventory')return json(response,state);
      if(url.pathname==='/control'&&request.method==='POST'){Object.assign(state,body);if(body.complete)for(const order of Object.values(state.orders))order.status='ready'; return json(response,state);}
      if(Object.hasOwn(pages,url.pathname)){response.setHeader('Content-Type','text/html; charset=utf-8');return response.end(await readFile(new URL('../public/'+pages[url.pathname],import.meta.url)));}
      
    if(url.pathname==='/purchase'&&request.method==='POST'){
      if(!body.requestId||!body.purpose)return json(response,{error:'缺少披露身份'},400);
      let order=state.orders[body.requestId];
      if(order&&(order.purpose!==body.purpose||order.version!==body.version))return json(response,{error:'披露冲突'},409);
      if(!order){if(body.maxPrice<state.price)return json(response,{price:state.price},402);order={id:body.requestId,purpose:body.purpose,version:body.version,charged:state.price,status:state.pending?'charged_waiting':'ready'};state.orders[order.id]=order;}
      if(state.dropResponse)return response.destroy();return json(response,order);
    }
    if(url.pathname.startsWith('/orders/')){const order=state.orders[url.pathname.split('/').pop()];return json(response,order||{error:'未受理'},order?200:404);}
    if(url.pathname.startsWith('/results/')){const order=state.orders[url.pathname.split('/').pop()];if(!order||order.status!=='ready')return json(response,{error:'未就绪'},409);return json(response,{order:order.id,version:order.version,purpose:order.purpose,records:[{id:'enterprise-1',name:'合成企业'}]});}

      return json(response,{error:'资源不存在'},404);
    }catch(error){if(!response.headersSent)json(response,{error:error.message},500);else response.destroy();}
  });
  await new Promise(resolve=>server.listen(port,host,resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,state,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
