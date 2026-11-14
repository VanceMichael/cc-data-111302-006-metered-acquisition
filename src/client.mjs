const LOOPBACK_HOSTS=new Set(['127.0.0.1','localhost','::1','[::1]']);

/**
 * The acquisition worker is deliberately restricted to a local, synthetic
 * supplier. Refusing non-loopback URLs makes an accidental test run against a
 * real paid disclosure endpoint impossible.
 */
export function assertLocalSource(url){
  const parsed=new URL(url);
  if(parsed.protocol!=='http:')throw new Error('来源必须使用本地 http 协议');
  if(!LOOPBACK_HOSTS.has(parsed.hostname))throw new Error('来源必须位于本机回环地址');
  return parsed.origin;
}

export class SourceError extends Error{
  constructor(message,{code='SOURCE_ERROR',status=null,body=null,cause=null}={}){
    super(message,{cause});
    this.name='SourceError';
    this.code=code;
    this.status=status;
    this.body=body;
  }
}

async function readBody(response){
  const bytes=Buffer.from(await response.arrayBuffer());
  const text=bytes.toString('utf8');
  let value=text;
  try{value=JSON.parse(text);}catch{}
  return {bytes,text,value};
}

/**
 * Thin, non-retrying HTTP client. Retrying a charged disclosure is a business
 * decision (same requestId, reconcile first), never a transport concern.
 */
export class SourceClient{
  #url;
  #timeoutMs;
  #fetch;

  constructor(url,{timeoutMs=2000,fetchImpl=globalThis.fetch}={}){
    this.#url=assertLocalSource(url);
    this.#timeoutMs=timeoutMs;
    this.#fetch=fetchImpl;
  }

  get url(){return this.#url;}

  async #request(path,{method='GET',body}={}){
    let response;
    try{
      response=await this.#fetch(this.#url+path,{
        method,
        headers:body===undefined?undefined:{'content-type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),
        signal:AbortSignal.timeout(this.#timeoutMs)
      });
    }catch(error){
      throw new SourceError(`来源请求失败: ${path}`,{code:'SOURCE_UNAVAILABLE',cause:error});
    }
    const payload=await readBody(response).catch(error=>{
      throw new SourceError(`来源响应读取失败: ${path}`,{code:'SOURCE_UNAVAILABLE',cause:error});
    });
    return {...payload,status:response.status,ok:response.ok};
  }

  async quote(){
    const response=await this.#request('/quote');
    if(!response.ok)throw new SourceError('来源报价读取失败',{code:'QUOTE_FAILED',status:response.status,body:response.value});
    if(!Number.isInteger(response.value?.price)||response.value.price<0)throw new SourceError('来源报价格式无效',{code:'QUOTE_INVALID',status:response.status,body:response.value});
    return response.value;
  }

  async purchase({requestId,purpose,version,maxPrice}){
    return this.#request('/purchase',{method:'POST',body:{requestId,purpose,version,maxPrice}});
  }

  async order(requestId){
    return this.#request(`/orders/${encodeURIComponent(requestId)}`);
  }

  async result(requestId){
    return this.#request(`/results/${encodeURIComponent(requestId)}`);
  }
}

export async function inspect(url){
  const response=await fetch(url+'/inventory',{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error(`目录读取失败: ${response.status}`);
  return response.json();
}
export async function readRaw(url,path){
  const response=await fetch(url+path,{signal:AbortSignal.timeout(2000)});
  if(!response.ok)throw new Error(`资料读取失败: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
