import {createHash, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {LedgerStore, nextEvent} from './store.mjs';
import {SourceClient} from './client.mjs';

export const DEFAULT_RESULT_TTL_MS=24*60*60*1000;

const OPEN_PHASES=new Set(['planned','reserved','sending','unknown','charged','charged_waiting']);
const TERMINAL_PHASES=new Set(['ready','released','failed']);

export class AcquisitionError extends Error{
  constructor(message,{code='ACQUISITION_ERROR',details={}}={}){
    super(message);
    this.name='AcquisitionError';
    this.code=code;
    this.details=details;
  }
}

function requireText(value,label,max=200){
  if(typeof value!=='string'||value.trim()===''||value.length>max){
    throw new AcquisitionError(`${label}必须是长度不超过${max}的非空字符串`,{code:'INVALID_INPUT'});
  }
  return value;
}
function requireInteger(value,label,{min=0}={}){
  if(!Number.isInteger(value)||value<min){
    throw new AcquisitionError(`${label}必须是不小于${min}的整数`,{code:'INVALID_INPUT'});
  }
  return value;
}
function requireTime(value,label,{optional=false}={}){
  if(value==null&&optional)return null;
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))){
    throw new AcquisitionError(`${label}必须是ISO时间`,{code:'INVALID_INPUT'});
  }
  return new Date(value).toISOString();
}
function digest(value){return createHash('sha256').update(value).digest('hex');}

function validateOrderDefinition(input){
  const id=requireText(input.id??`po-${randomUUID()}`,'采购单号',120);
  const purpose=requireText(input.purpose,'授权用途',120);
  const version=requireInteger(input.version,'资料版本',{min:1});
  const budget=requireInteger(input.budget,'预算');
  const deadline=requireTime(input.deadline,'截止时间');
  return {id,purpose,version,budget,deadline};
}

function sameDefinition(order,definition){
  return order.purpose===definition.purpose
    &&order.version===definition.version
    &&order.budget===definition.budget
    &&order.deadline===definition.deadline;
}

function committedFor(state,order){
  let committed=0;
  for(const id of order.lines){
    const line=state.lines[id];
    if(!line)continue;
    committed+=(line.reserved??0)+(line.actual??0);
  }
  return committed;
}

function pushAttempt(line,attempt){
  line.attempts.push(attempt);
  if(line.attempts.length>100)line.attempts.splice(0,line.attempts.length-100);
}

function releaseHold(line,{reason,code,at}){
  const released=line.reserved??0;
  line.released=(line.released??0)+released;
  line.reserved=0;
  line.phase='released';
  line.releaseReason=reason??code??'released';
  line.lastError=code?{code,message:reason??code,at}:line.lastError??null;
  line.updatedAt=at;
  return released;
}

/**
 * Acquisition engine for metered disclosures.
 *
 * Accounting invariant: a purchase order's committed amount is
 * sum(line.reserved + line.actual). Budget is only ever checked against the
 * same purchase order; one order can neither see nor borrow another order's
 * budget.
 *
 * Crash safety invariant: a line becomes `sending` (persisted and fsynced)
 * before the HTTP purchase leaves the process. Recovery therefore never POSTs
 * a line found in `sending`/`unknown`; it uses only the supplier's order-lookup
 * endpoint. The same stable requestId is reused for every retry.
 */
export class AcquisitionEngine{
  #client;
  #store;
  #clock;
  #resultTtlMs;
  #reconcileOnSendFailure;
  #priceRetries;
  #hooks;
  #locks=new Map();

  constructor({sourceUrl,client,fetchImpl,timeoutMs=2000,clock=Date.now,resultTtlMs=DEFAULT_RESULT_TTL_MS,reconcileOnSendFailure=true,priceRetries=2,hooks={}}={}){
    this.#client=client??new SourceClient(sourceUrl,{timeoutMs,fetchImpl});
    this.#clock=clock;
    this.#resultTtlMs=resultTtlMs;
    requireInteger(resultTtlMs,'复用有效期');
    this.#reconcileOnSendFailure=reconcileOnSendFailure;
    this.#priceRetries=requireInteger(priceRetries,'报价重试次数');
    this.#hooks=hooks;
  }

  get client(){return this.#client;}

  static async open(options={}){
    const engine=new AcquisitionEngine(options);
    engine.#store=new LedgerStore(resolve(options.ledgerPath??'.local/ledger.json'));
    await engine.#store.load();
    return engine;
  }

  get ledgerPath(){return this.#store.path;}

  get state(){return this.#store.state;}

  #line(lineId){
    const line=this.#store.state.lines[lineId];
    if(!line)throw new AcquisitionError(`未知领取任务: ${lineId}`,{code:'LINE_NOT_FOUND'});
    return line;
  }

  #order(orderId){
    const order=this.#store.state.orders[orderId];
    if(!order)throw new AcquisitionError(`未知采购单: ${orderId}`,{code:'ORDER_NOT_FOUND'});
    return order;
  }

  #withLineLock(lineId,operation){
    const previous=this.#locks.get(lineId)??Promise.resolve();
    const current=previous.then(operation,operation);
    const tail=current.then(()=>undefined,()=>undefined);
    this.#locks.set(lineId,tail);
    tail.finally(()=>{if(this.#locks.get(lineId)===tail)this.#locks.delete(lineId);});
    return current;
  }

  async defineOrder(input={}){
    const definition=validateOrderDefinition(input);
    const now=this.#clock();
    if(Date.parse(definition.deadline)<=now){
      throw new AcquisitionError('采购单截止时间必须晚于当前时间',{code:'ORDER_DEADLINE_PASSED'});
    }
    const order=await this.#store.update(draft=>{
      const existing=draft.orders[definition.id];
      if(existing){
        if(!sameDefinition(existing,definition)){
          throw new AcquisitionError('同名采购单的定义不一致',{code:'ORDER_CONFLICT',details:{orderId:definition.id}});
        }
        return {created:false};
      }
      draft.orders[definition.id]={
        ...definition,
        status:'active',
        cancelledAt:null,
        createdAt:new Date(now).toISOString(),
        lines:[]
      };
      nextEvent(draft,'order.defined',{orderId:definition.id,purpose:definition.purpose,version:definition.version,budget:definition.budget,deadline:definition.deadline,at:new Date(now).toISOString()});
      return {created:true};
    });
    return {order:this.presentOrder(definition.id),created:order.created};
  }

  async enqueue({orderId,entityKey}={}){
    requireText(orderId,'采购单号',120);
    requireText(entityKey,'资料标识',200);
    const now=this.#clock();
    const result=await this.#store.update(draft=>{
      const order=draft.orders[orderId];
      if(!order)throw new AcquisitionError(`未知采购单: ${orderId}`,{code:'ORDER_NOT_FOUND'});
      if(order.status!=='active'){
        throw new AcquisitionError('采购单已取消，不能新增领取',{code:'ORDER_CANCELLED',details:{orderId}});
      }
      if(now>Date.parse(order.deadline)){
        throw new AcquisitionError('采购单已过截止时间，不能新增领取',{code:'ORDER_DEADLINE_PASSED',details:{orderId}});
      }
      const existingId=order.lines.find(id=>{
        const line=draft.lines[id];
        return line&&line.entityKey===entityKey&&line.phase!=='failed'&&line.phase!=='released';
      });
      if(existingId)return {lineId:existingId,existing:true};

      const lineId=`line-${randomUUID()}`;
      const line={
        id:lineId,
        orderId,
        entityKey,
        requestId:`acq-${randomUUID()}`,
        phase:'planned',
        reserved:0,
        actual:0,
        released:0,
        quote:null,
        quoteRetries:0,
        disclosureId:null,
        reusedFrom:null,
        result:null,
        attempts:[],
        lastError:null,
        cancelRequested:false,
        cancelledAt:null,
        createdAt:new Date(now).toISOString(),
        updatedAt:new Date(now).toISOString()
      };
      draft.lines[lineId]=line;
      order.lines.push(lineId);
      nextEvent(draft,'line.enqueued',{orderId,lineId,entityKey,requestId:line.requestId,at:line.createdAt});
      return {lineId,existing:false};
    });
    return {line:this.presentLine(result.lineId),existing:result.existing};
  }

  /**
   * Reconcile lines whose purchase outcome is unknown. This performs only
   * unpaid order lookups; it never issues a purchase.
   */
  async recover(){
    const ids=Object.values(this.#store.state.lines)
      .filter(line=>['sending','unknown','charged','charged_waiting'].includes(line.phase))
      .map(line=>line.id);
    const results=[];
    for(const id of ids){
      results.push(await this.#withLineLock(id,async()=>{
        const line=this.#line(id);
        if(line.phase==='sending'||line.phase==='unknown')await this.#reconcile(id);
        else if(line.phase==='charged'||line.phase==='charged_waiting')await this.#fetchResult(id);
        return this.#line(id);
      }));
    }
    return results.map(line=>this.presentLine(line.id));
  }

  async processOrder(orderId,{lineIds}={}){
    this.#order(orderId);
    const wanted=lineIds?new Set(lineIds):null;
    const ids=this.#store.state.orders[orderId].lines.filter(id=>!wanted||wanted.has(id));
    const results=[];
    for(const id of ids){
      const line=this.#store.state.lines[id];
      if(!line)continue;
      if(!OPEN_PHASES.has(line.phase))continue;
      try{
        results.push(await this.processLine(id));
      }catch(error){
        results.push({...this.presentLine(id),processingError:{code:error.code??'PROCESS_ERROR',message:error.message}});
      }
    }
    return results;
  }

  async processLine(lineId){
    await this.#withLineLock(lineId,async()=>{
      for(let round=0;round<8;round+=1){
        const line=this.#line(lineId);
        if(TERMINAL_PHASES.has(line.phase))return;
        if(line.phase==='planned'){
          if(!await this.#reuseOrReserve(lineId))return;
        }else if(line.phase==='reserved'){
          await this.#send(lineId);
        }else if(line.phase==='sending'||line.phase==='unknown'){
          await this.#reconcile(lineId);
        }else if(line.phase==='charged'||line.phase==='charged_waiting'){
          await this.#fetchResult(lineId);
        }
        const next=this.#line(lineId);
        if(TERMINAL_PHASES.has(next.phase))return;
        if(next.phase==='charged_waiting'||next.phase==='unknown')return;
      }
    });
    return this.presentLine(lineId);
  }

  #findReusable(order,entityKey){
    const now=this.#clock();
    let best=null;
    for(const disclosure of Object.values(this.#store.state.disclosures)){
      if(disclosure.status!=='ready'||!disclosure.result||!disclosure.expiresAt)continue;
      if(disclosure.purpose!==order.purpose||disclosure.version!==order.version)continue;
      if(disclosure.entityKey!==entityKey)continue;
      if(Date.parse(disclosure.expiresAt)<=now)continue;
      if(!best||Date.parse(disclosure.retrievedAt)>Date.parse(best.retrievedAt))best=disclosure;
    }
    return best;
  }

  async #reuseOrReserve(lineId){
    const line=this.#line(lineId);
    const order=this.#order(line.orderId);
    const now=this.#clock();

    // Cancellation wins over reuse: a claim that has not been sent must stop,
    // even if an old disclosure happens to be reusable.
    if(order.status!=='active'||now>Date.parse(order.deadline)){
      await this.#closeUnsellable(lineId,order.status!=='active'?'ORDER_CANCELLED':'ORDER_DEADLINE_PASSED',now);
      return false;
    }

    // A disclosure is reusable only under the same purpose and data version,
    // and only while its result is unexpired. Matching content alone is not
    // an authorization to reuse it.
    const reuse=this.#findReusable(order,line.entityKey);
    if(reuse){
      const changed=await this.#store.update(draft=>{
        const current=draft.lines[lineId];
        if(!current||current.phase!=='planned')return false;
        if(draft.orders[current.orderId].status!=='active')return false;
        current.phase='ready';
        current.reused=true;
        current.reusedFrom=reuse.id;
        current.disclosureId=reuse.id;
        current.result=structuredClone(reuse.result);
        current.readyAt=new Date(now).toISOString();
        current.updatedAt=new Date(now).toISOString();
        current.lastError=null;
        nextEvent(draft,'line.reused',{orderId:current.orderId,lineId,entityKey:current.entityKey,disclosureId:reuse.id,purpose:order.purpose,version:order.version,at:current.readyAt});
        return true;
      });
      return changed;
    }

    let quote;
    try{
      quote=await this.#client.quote();
    }catch(error){
      await this.#recordError(lineId,'quote',error,now);
      return false;
    }

    if(quote.datasetVersion!==order.version){
      const closed=await this.#store.update(draft=>{
        const current=draft.lines[lineId];
        if(!current||current.phase!=='planned')return false;
        releaseHold(current,{code:'VERSION_UNAVAILABLE',reason:`来源当前版本 ${quote.datasetVersion} 不符合采购单版本 ${order.version}`,at:new Date(now).toISOString()});
        current.phase='failed';
        pushAttempt(current,{at:new Date(now).toISOString(),action:'quote',outcome:'version_mismatch',sourceVersion:quote.datasetVersion,requiredVersion:order.version});
        nextEvent(draft,'line.failed',{orderId:current.orderId,lineId,code:'VERSION_UNAVAILABLE',at:current.updatedAt});
        return true;
      });
      return closed;
    }

    const reserved=await this.#store.update(draft=>{
      const current=draft.lines[lineId];
      if(!current||current.phase!=='planned')return {ok:false};
      const currentOrder=draft.orders[current.orderId];
      if(currentOrder.status!=='active'){
        releaseHold(current,{code:'ORDER_CANCELLED',reason:'采购单已取消',at:new Date(now).toISOString()});
        pushAttempt(current,{at:current.updatedAt,action:'reserve',outcome:'cancelled'});
        nextEvent(draft,'line.released',{orderId:current.orderId,lineId,reason:'order_cancelled',at:current.updatedAt});
        return {ok:false};
      }
      if(now>Date.parse(currentOrder.deadline)){
        current.phase='failed';
        releaseHold(current,{code:'ORDER_DEADLINE_PASSED',reason:'采购单已过截止时间',at:new Date(now).toISOString()});
        pushAttempt(current,{at:current.updatedAt,action:'reserve',outcome:'deadline_passed'});
        nextEvent(draft,'line.failed',{orderId:current.orderId,lineId,code:'ORDER_DEADLINE_PASSED',at:current.updatedAt});
        return {ok:false};
      }
      const committed=committedFor(draft,currentOrder);
      const available=currentOrder.budget-committed;
      if(quote.price>available){
        current.phase='failed';
        current.quote={price:quote.price,datasetVersion:quote.datasetVersion,at:new Date(now).toISOString()};
        current.lastError={code:'BUDGET_EXCEEDED',message:`报价 ${quote.price} 超过采购单可用预算 ${available}`,at:new Date(now).toISOString()};
        current.updatedAt=new Date(now).toISOString();
        pushAttempt(current,{at:current.updatedAt,action:'reserve',outcome:'budget_exceeded',price:quote.price,available});
        nextEvent(draft,'line.failed',{orderId:current.orderId,lineId,code:'BUDGET_EXCEEDED',price:quote.price,available,at:current.updatedAt});
        return {ok:false};
      }
      current.phase='reserved';
      current.quote={price:quote.price,datasetVersion:quote.datasetVersion,at:new Date(now).toISOString()};
      current.reserved=quote.price;
      current.maxPrice=quote.price;
      current.reservedAt=new Date(now).toISOString();
      current.updatedAt=new Date(now).toISOString();
      current.lastError=null;
      pushAttempt(current,{at:current.updatedAt,action:'reserve',outcome:'reserved',price:quote.price});
      nextEvent(draft,'line.reserved',{orderId:current.orderId,lineId,price:quote.price,at:current.updatedAt});
      return {ok:true};
    });
    return reserved.ok;
  }

  async #closeUnsellable(lineId,code,now){
    return this.#store.update(draft=>{
      const line=draft.lines[lineId];
      if(!line||line.phase!=='planned')return false;
      releaseHold(line,{code,reason:code==='ORDER_CANCELLED'?'采购单已取消':'采购单已过截止时间',at:new Date(now).toISOString()});
      line.updatedAt=new Date(now).toISOString();
      pushAttempt(line,{at:line.updatedAt,action:'close',outcome:code});
      nextEvent(draft,'line.failed',{orderId:line.orderId,lineId,code,at:line.updatedAt});
      return true;
    });
  }

  async #recordError(lineId,action,error,now){
    return this.#store.update(draft=>{
      const line=draft.lines[lineId];
      if(!line)return false;
      line.lastError={code:error.code??'SOURCE_ERROR',message:error.message,at:new Date(now).toISOString()};
      line.updatedAt=new Date(now).toISOString();
      pushAttempt(line,{at:line.updatedAt,action,outcome:'error',code:line.lastError.code,message:line.lastError.message});
      nextEvent(draft,'line.source_error',{orderId:line.orderId,lineId,action,code:line.lastError.code,at:line.updatedAt});
      return true;
    });
  }

  async #send(lineId){
    const now=this.#clock();
    const started=await this.#store.update(draft=>{
      const line=draft.lines[lineId];
      if(!line||line.phase!=='reserved')return {send:false};
      const order=draft.orders[line.orderId];
      if(order.status!=='active'||now>Date.parse(order.deadline)||line.cancelRequested){
        releaseHold(line,{
          code:order.status!=='active'?'ORDER_CANCELLED':now>Date.parse(order.deadline)?'ORDER_DEADLINE_PASSED':'LINE_CANCELLED',
          reason:'发送前采购单已取消或过期',
          at:new Date(now).toISOString()
        });
        line.cancelledAt=new Date(now).toISOString();
        pushAttempt(line,{at:line.updatedAt,action:'send',outcome:'cancelled_before_send'});
        nextEvent(draft,'line.released',{orderId:line.orderId,lineId,reason:'cancelled_before_send',at:line.updatedAt});
        return {send:false};
      }
      // Persisted before the request leaves this process. If the process dies
      // after this point, recovery looks the requestId up and never re-buys.
      line.phase='sending';
      line.sendingAt=new Date(now).toISOString();
      line.updatedAt=line.sendingAt;
      pushAttempt(line,{at:line.sendingAt,action:'send',outcome:'started',requestId:line.requestId,maxPrice:line.maxPrice});
      nextEvent(draft,'line.send_started',{orderId:line.orderId,lineId,requestId:line.requestId,maxPrice:line.maxPrice,at:line.sendingAt});
      return {send:true};
    });
    if(!started.send)return false;

    if(typeof this.#hooks.beforePurchase==='function'){
      await this.#hooks.beforePurchase({lineId,requestId:this.#line(lineId).requestId,snapshot:this.presentLine(lineId)});
    }

    // Cancellation may have arrived between the persisted send marker and the
    // actual HTTP call. No request has left yet in this process, so it is safe
    // to release rather than treat this as an ambiguous charge. A hook may also
    // have reconciled the line already; in that case do not send either.
    const afterHook=this.#line(lineId);
    if(afterHook.phase!=='sending')return false;
    {
      const order=this.#order(afterHook.orderId);
      const halted=order.status!=='active'||this.#clock()>Date.parse(order.deadline)||afterHook.cancelRequested;
      if(halted){
        await this.#store.update(draft=>{
          const line=draft.lines[lineId];
          if(!line||line.phase!=='sending')return;
          releaseHold(line,{code:'CANCELLED_BEFORE_REQUEST',reason:'取消发生在请求发出之前',at:new Date(this.#clock()).toISOString()});
          line.cancelledAt=new Date(this.#clock()).toISOString();
          pushAttempt(line,{at:line.updatedAt,action:'send',outcome:'cancelled_before_request'});
          nextEvent(draft,'line.released',{orderId:line.orderId,lineId,reason:'cancelled_before_request',at:line.updatedAt});
        });
        return false;
      }
    }

    let response;
    try{
      response=await this.#client.purchase({
        requestId:afterHook.requestId,
        purpose:this.#order(afterHook.orderId).purpose,
        version:this.#order(afterHook.orderId).version,
        maxPrice:afterHook.maxPrice
      });
    }catch(error){
      if(typeof this.#hooks.afterSendFailure==='function'){
        await this.#hooks.afterSendFailure({
          lineId,
          requestId:afterHook.requestId,
          error,
          snapshot:this.presentLine(lineId)
        });
      }
      await this.#markUnknown(lineId,error,this.#clock());
      if(this.#reconcileOnSendFailure)await this.#reconcile(lineId);
      return false;
    }

    if(response.status===200){
      const body=response.value;
      if(body&&body.id===afterHook.requestId&&Number.isInteger(body.charged)&&body.charged>=0){
        await this.#settleCharged(lineId,body,this.#clock());
        await this.#fetchResult(lineId);
      }else{
        await this.#markUnknown(lineId,new Error('来源受理响应格式无效'),this.#clock());
        if(this.#reconcileOnSendFailure)await this.#reconcile(lineId);
      }
      return false;
    }
    if(response.status===402){
      const now2=this.#clock();
      await this.#store.update(draft=>{
        const line=draft.lines[lineId];
        if(!line||line.phase!=='sending')return;
        releaseHold(line,{code:'PRICE_CHANGED',reason:'来源报价上涨，未受理',at:new Date(now2).toISOString()});
        line.quoteRetries+=1;
        line.quote=null;
        pushAttempt(line,{at:line.updatedAt,action:'purchase',outcome:'price_changed',sourcePrice:response.value?.price??null});
        if(line.quoteRetries>this.#priceRetries){
          line.phase='failed';
          line.lastError={code:'PRICE_CHANGED',message:'报价上涨次数超过允许的重试次数',at:line.updatedAt};
          nextEvent(draft,'line.failed',{orderId:line.orderId,lineId,code:'PRICE_CHANGED',at:line.updatedAt});
        }else{
          line.phase='planned';
          line.lastError=null;
          nextEvent(draft,'line.requote',{orderId:line.orderId,lineId,attempt:line.quoteRetries,at:line.updatedAt});
        }
      });
      return false;
    }
    if(response.status===409){
      // Do not assume the failed attempt was free: ask the supplier by the
      // same requestId before releasing anything.
      await this.#reconcile(lineId);
      return false;
    }
    if(response.status===400){
      await this.#store.update(draft=>{
        const line=draft.lines[lineId];
        if(!line||line.phase!=='sending')return;
        releaseHold(line,{code:'REQUEST_REJECTED',reason:'来源拒绝请求',at:new Date(this.#clock()).toISOString()});
        line.phase='failed';
        line.lastError={code:'REQUEST_REJECTED',message:response.value?.error??'来源拒绝请求',at:line.updatedAt};
        pushAttempt(line,{at:line.updatedAt,action:'purchase',outcome:'rejected',status:400});
        nextEvent(draft,'line.failed',{orderId:line.orderId,lineId,code:'REQUEST_REJECTED',at:line.updatedAt});
      });
      return false;
    }
    // Any other status may have been produced after acceptance. Reconcile by
    // requestId; never blindly POST again.
    await this.#markUnknown(lineId,new Error(`来源返回意外状态 ${response.status}`),this.#clock());
    if(this.#reconcileOnSendFailure)await this.#reconcile(lineId);
    return false;
  }

  async #markUnknown(lineId,error,now){
    return this.#store.update(draft=>{
      const line=draft.lines[lineId];
      if(!line||line.phase!=='sending')return;
      line.phase='unknown';
      line.updatedAt=new Date(now).toISOString();
      line.lastError={code:error.code??'CHARGE_UNKNOWN',message:error.message,at:line.updatedAt};
      pushAttempt(line,{at:line.updatedAt,action:'purchase',outcome:'unknown',code:line.lastError.code,message:line.lastError.message});
      nextEvent(draft,'line.charge_unknown',{orderId:line.orderId,lineId,requestId:line.requestId,reserved:line.reserved,at:line.updatedAt});
      return true;
    });
  }

  async #reconcile(lineId){
    const line=this.#line(lineId);
    if(line.phase!=='sending'&&line.phase!=='unknown')return line;
    let response;
    try{
      response=await this.#client.order(line.requestId);
    }catch(error){
      await this.#recordReconcileFailure(lineId,error);
      return this.#line(lineId);
    }
    if(response.status===200){
      const body=response.value;
      if(body&&body.id===line.requestId&&Number.isInteger(body.charged)&&body.charged>=0){
        await this.#settleCharged(lineId,body,this.#clock());
        await this.#fetchResult(lineId);
      }else{
        await this.#recordReconcileFailure(lineId,new Error('查单响应格式无效'));
      }
      return this.#line(lineId);
    }
    if(response.status===404){
      const now=this.#clock();
      await this.#store.update(draft=>{
        const current=draft.lines[lineId];
        if(!current||(current.phase!=='sending'&&current.phase!=='unknown'))return;
        releaseHold(current,{code:'SOURCE_NOT_ACCEPTED',reason:'来源查单确认从未受理',at:new Date(now).toISOString()});
        current.phase='released';
        current.lastError={code:'SOURCE_NOT_ACCEPTED',message:'来源查单确认从未受理',at:current.updatedAt};
        pushAttempt(current,{at:current.updatedAt,action:'reconcile',outcome:'not_accepted',status:404});
        nextEvent(draft,'line.released',{orderId:current.orderId,lineId,reason:'source_not_accepted',at:current.updatedAt});
      });
      return this.#line(lineId);
    }
    await this.#recordReconcileFailure(lineId,new Error(`查单返回意外状态 ${response.status}`));
    return this.#line(lineId);
  }

  async #recordReconcileFailure(lineId,error){
    return this.#store.update(draft=>{
      const line=draft.lines[lineId];
      if(!line||(line.phase!=='sending'&&line.phase!=='unknown'))return;
      line.phase='unknown';
      line.lastError={code:error.code??'RECONCILE_FAILED',message:error.message,at:new Date(this.#clock()).toISOString()};
      line.updatedAt=new Date(this.#clock()).toISOString();
      pushAttempt(line,{at:line.updatedAt,action:'reconcile',outcome:'error',code:line.lastError.code,message:line.lastError.message});
      nextEvent(draft,'line.reconcile_failed',{orderId:line.orderId,lineId,at:line.updatedAt});
      return true;
    });
  }

  /**
   * Apply a supplier's accepted/charged order to the ledger. Safe to call more
   * than once: only a line still in `sending`/`unknown` is settled.
   */
  async #settleCharged(lineId,sourceOrder,now){
    return this.#store.update(draft=>{
      const line=draft.lines[lineId];
      if(!line||(line.phase!=='sending'&&line.phase!=='unknown'))return false;
      const order=draft.orders[line.orderId];
      const charged=sourceOrder.charged;
      let hold=line.reserved??0;
      let overage=0;
      if(charged>hold){
        const available=Math.max(0,order.budget-committedFor(draft,order));
        const extra=charged-hold;
        const covered=Math.min(extra,available);
        hold+=covered;
        overage=extra-covered;
      }
      const leftover=Math.max(0,hold-charged);
      line.released=(line.released??0)+leftover;
      line.reserved=0;
      line.actual=(line.actual??0)+charged;
      line.chargedBySource=charged;
      line.sourceStatus=sourceOrder.status??null;
      line.overage=(line.overage??0)+overage;
      line.phase='charged';
      line.lastError=null;
      line.updatedAt=new Date(now).toISOString();
      line.settledAt=line.updatedAt;
      if(overage>0){
        line.overBudget=true;
        nextEvent(draft,'line.over_budget',{orderId:line.orderId,lineId,charged,covered:hold,overage,at:line.updatedAt});
      }
      const disclosureId=line.disclosureId??`dis-${digest(line.requestId).slice(0,24)}`;
      line.disclosureId=disclosureId;
      draft.disclosures[disclosureId]={
        id:disclosureId,
        orderId:line.orderId,
        lineId,
        entityKey:line.entityKey,
        requestId:line.requestId,
        purpose:order.purpose,
        version:order.version,
        charged,
        status:sourceOrder.status==='ready'?'charged':'charged_waiting',
        result:null,
        retrievedAt:null,
        expiresAt:null,
        createdAt:new Date(now).toISOString()
      };
      pushAttempt(line,{at:line.updatedAt,action:'settle',outcome:'charged',charged});
      nextEvent(draft,'line.charged',{orderId:line.orderId,lineId,requestId:line.requestId,charged,overage,at:line.updatedAt});
      return true;
    });
  }

  async #fetchResult(lineId){
    const line=this.#line(lineId);
    if(line.phase!=='charged'&&line.phase!=='charged_waiting')return;
    if(!line.disclosureId)return;
    let response;
    try{
      response=await this.#client.result(line.requestId);
    }catch(error){
      await this.#store.update(draft=>{
        const current=draft.lines[lineId];
        if(!current||(current.phase!=='charged'&&current.phase!=='charged_waiting'))return;
        current.phase='charged_waiting';
        current.updatedAt=new Date(this.#clock()).toISOString();
        current.lastError={code:error.code??'RESULT_UNAVAILABLE',message:error.message,at:current.updatedAt};
        pushAttempt(current,{at:current.updatedAt,action:'result',outcome:'error',code:current.lastError.code});
        nextEvent(draft,'line.result_pending',{orderId:current.orderId,lineId,at:current.updatedAt});
      });
      return;
    }
    if(response.status===200&&response.value?.order===line.requestId){
      const retrievedAt=new Date(this.#clock()).toISOString();
      const raw={
        sourceStatus:response.status,
        contentType:'application/json; charset=utf-8',
        sha256:digest(response.bytes),
        bytesBase64:response.bytes.toString('base64'),
        json:response.value,
        retrievedAt
      };
      await this.#store.update(draft=>{
        const current=draft.lines[lineId];
        if(!current||(current.phase!=='charged'&&current.phase!=='charged_waiting'))return;
        current.result=raw;
        current.phase='ready';
        current.readyAt=retrievedAt;
        current.updatedAt=retrievedAt;
        current.lastError=null;
        pushAttempt(current,{at:retrievedAt,action:'result',outcome:'ready',bytes:response.bytes.length});
        const disclosure=draft.disclosures[current.disclosureId];
        if(disclosure){
          disclosure.status='ready';
          disclosure.result=structuredClone(raw);
          disclosure.retrievedAt=retrievedAt;
          disclosure.expiresAt=new Date(Date.parse(retrievedAt)+this.#resultTtlMs).toISOString();
        }
        nextEvent(draft,'line.ready',{orderId:current.orderId,lineId,sha256:raw.sha256,expiresAt:draft.disclosures[current.disclosureId]?.expiresAt??null,at:retrievedAt});
      });
      return;
    }
    if(response.status===409){
      await this.#store.update(draft=>{
        const current=draft.lines[lineId];
        if(!current||(current.phase!=='charged'&&current.phase!=='charged_waiting'))return;
        current.phase='charged_waiting';
        current.updatedAt=new Date(this.#clock()).toISOString();
        current.lastError={code:'RESULT_NOT_READY',message:'已收费但结果尚不可取',at:current.updatedAt};
        pushAttempt(current,{at:current.updatedAt,action:'result',outcome:'pending',status:409});
        nextEvent(draft,'line.result_pending',{orderId:current.orderId,lineId,at:current.updatedAt});
      });
      return;
    }
    await this.#store.update(draft=>{
      const current=draft.lines[lineId];
      if(!current||(current.phase!=='charged'&&current.phase!=='charged_waiting'))return;
      current.phase='charged_waiting';
      current.updatedAt=new Date(this.#clock()).toISOString();
      current.lastError={code:'RESULT_UNAVAILABLE',message:`资料读取返回 ${response.status}`,at:current.updatedAt};
      pushAttempt(current,{at:current.updatedAt,action:'result',outcome:'error',status:response.status});
      nextEvent(draft,'line.result_pending',{orderId:current.orderId,lineId,at:current.updatedAt});
    });
  }

  /**
   * Persist the cancellation decision without waiting for in-flight lines.
   * This is safe to call from a send hook (it takes no line lock) and makes a
   * queued, not-yet-sent claim stop at the next durable checkpoint.
   */
  async requestCancelOrder(orderId,{reason='需求取消',actor=null}={}){
    const now=this.#clock();
    return this.#store.update(draft=>{
      const order=draft.orders[orderId];
      if(!order)throw new AcquisitionError(`未知采购单: ${orderId}`,{code:'ORDER_NOT_FOUND'});
      if(order.status==='cancelled')return {orderId,status:'cancelled'};
      order.status='cancelled';
      order.cancelledAt=new Date(now).toISOString();
      order.cancelReason=reason;
      order.cancelledBy=actor;
      for(const lineId of order.lines){
        const line=draft.lines[lineId];
        if(!line)continue;
        line.cancelRequested=true;
        line.cancelledAt=line.cancelledAt??new Date(now).toISOString();
        if(line.phase==='planned'||line.phase==='reserved'){
          const released=releaseHold(line,{code:'ORDER_CANCELLED',reason,at:new Date(now).toISOString()});
          line.updatedAt=new Date(now).toISOString();
          pushAttempt(line,{at:line.updatedAt,action:'cancel',outcome:'released_before_send',released});
          nextEvent(draft,'line.released',{orderId,lineId,reason:'order_cancelled',released,at:line.updatedAt});
        }else if(line.phase==='sending'||line.phase==='unknown'){
          pushAttempt(line,{at:new Date(now).toISOString(),action:'cancel',outcome:'reconcile_in_flight'});
        }else if(line.phase==='charged'||line.phase==='charged_waiting'||line.phase==='ready'){
          // The supplier has already disclosed and charged. Keep the fact and
          // continue (or retry) collecting the raw result; do not refund.
          pushAttempt(line,{at:new Date(now).toISOString(),action:'cancel',outcome:'retain_charge',charged:line.actual});
        }
      }
      nextEvent(draft,'order.cancelled',{orderId,reason,actor,at:order.cancelledAt});
      return {orderId,status:'cancelled'};
    });
  }

  /**
   * Cancel a purchase order. Unsent claims are released; in-flight claims are
   * reconciled instead of being refunded by assumption; already charged
   * disclosures remain in the ledger and are still accounted for.
   */
  async cancelOrder(orderId,{reason='需求取消',actor=null}={}){
    await this.requestCancelOrder(orderId,{reason,actor});
    const toReconcile=this.#store.state.orders[orderId].lines.filter(id=>{
      const line=this.#store.state.lines[id];
      return line&&(line.phase==='sending'||line.phase==='unknown'||line.phase==='charged'||line.phase==='charged_waiting');
    });
    for(const lineId of toReconcile){
      await this.#withLineLock(lineId,async()=>{
        const line=this.#line(lineId);
        if(line.phase==='sending'||line.phase==='unknown')await this.#reconcile(lineId);
        else if(line.phase==='charged'||line.phase==='charged_waiting')await this.#fetchResult(lineId);
      });
    }
    return this.presentOrder(orderId);
  }

  /**
   * Manual handling of an unknown charge. Evidence and operator are mandatory
   * and are written to the audit trail next to the decision.
   */
  async resolveUnknown({lineId,outcome,amount,result,evidence,operator}={}){
    requireText(lineId,'领取任务',120);
    requireText(evidence,'处理依据',2000);
    requireText(operator,'处理人',120);
    if(!['charged','not_charged','requery'].includes(outcome)){
      throw new AcquisitionError('outcome 必须是 charged、not_charged 或 requery',{code:'INVALID_INPUT'});
    }
    if(outcome==='charged')requireInteger(amount,'实际扣费');

    if(outcome==='requery'){
      const line=await this.#withLineLock(lineId,()=>this.#reconcile(lineId));
      await this.#store.update(draft=>{
        nextEvent(draft,'line.manual_resolution',{orderId:line.orderId,lineId,outcome,operator,evidence,decision:'requery',at:new Date(this.#clock()).toISOString()});
      });
      return this.presentLine(lineId);
    }

    await this.#withLineLock(lineId,()=>this.#store.update(draft=>{
      const line=draft.lines[lineId];
      if(!line)throw new AcquisitionError(`未知领取任务: ${lineId}`,{code:'LINE_NOT_FOUND'});
      if(line.phase!=='unknown'&&line.phase!=='sending'){
        throw new AcquisitionError('只能人工处理状态为 unknown 的费用',{code:'LINE_NOT_UNKNOWN',details:{phase:line.phase}});
      }
      const order=draft.orders[line.orderId];
      const at=new Date(this.#clock()).toISOString();
      if(outcome==='not_charged'){
        releaseHold(line,{code:'MANUAL_NOT_CHARGED',reason:evidence,at});
        line.phase='released';
      }else{
        const rawResult=result??null;
        const hold=line.reserved??0;
        let overage=0;
        if(amount>hold){
          const available=Math.max(0,order.budget-committedFor(draft,order));
          overage=Math.max(0,amount-hold-available);
        }
        line.released=(line.released??0)+Math.max(0,hold-amount);
        line.reserved=0;
        line.actual=(line.actual??0)+amount;
        line.chargedBySource=amount;
        line.overage=(line.overage??0)+overage;
        line.overBudget=overage>0||line.overBudget===true;
        line.phase=rawResult?'ready':'charged';
        if(rawResult){
          const retrievedAt=rawResult.retrievedAt??at;
          line.result={...rawResult,retrievedAt};
          line.readyAt=retrievedAt;
          const disclosureId=line.disclosureId??`dis-${digest(line.requestId).slice(0,24)}`;
          line.disclosureId=disclosureId;
          draft.disclosures[disclosureId]={
            id:disclosureId,orderId:line.orderId,lineId,entityKey:line.entityKey,requestId:line.requestId,
            purpose:order.purpose,version:order.version,charged:amount,status:'ready',result:structuredClone(line.result),
            retrievedAt,expiresAt:new Date(Date.parse(retrievedAt)+this.#resultTtlMs).toISOString(),createdAt:at
          };
        }
      }
      line.updatedAt=at;
      line.lastError=null;
      pushAttempt(line,{at,action:'manual_resolution',outcome,amount:amount??null,operator});
      nextEvent(draft,'line.manual_resolution',{orderId:line.orderId,lineId,outcome,amount:amount??null,operator,evidence,at});
      return true;
    }));
    const line=this.#line(lineId);
    if(outcome==='charged'&&!line.result&&(line.phase==='charged'||line.phase==='charged_waiting')){
      await this.#withLineLock(lineId,()=>this.#fetchResult(lineId));
    }
    return this.presentLine(lineId);
  }

  presentLine(lineId){
    const line=this.#line(lineId);
    const unknownAmount=line.phase==='unknown'||line.phase==='sending'?(line.reserved??0):0;
    return structuredClone({
      id:line.id,
      orderId:line.orderId,
      entityKey:line.entityKey,
      requestId:line.requestId,
      phase:line.phase,
      cancelledAt:line.cancelledAt??null,
      cancelRequested:line.cancelRequested===true,
      reserved:line.reserved??0,
      actual:line.actual??0,
      released:line.released??0,
      unknownAmount,
      overage:line.overage??0,
      overBudget:line.overBudget===true,
      quote:line.quote??null,
      maxPrice:line.maxPrice??null,
      reused:line.reused===true,
      reusedFrom:line.reusedFrom??null,
      disclosureId:line.disclosureId??null,
      chargedBySource:line.chargedBySource??null,
      sourceStatus:line.sourceStatus??null,
      attempts:structuredClone(line.attempts??[]),
      lastError:line.lastError??null,
      result:line.result?structuredClone(line.result):null,
      createdAt:line.createdAt,
      updatedAt:line.updatedAt
    });
  }

  presentOrder(orderId){
    const order=this.#order(orderId);
    const lines=order.lines.map(id=>this.presentLine(id));
    const reserved=lines.reduce((sum,line)=>sum+line.reserved,0);
    const actual=lines.reduce((sum,line)=>sum+line.actual,0);
    const released=lines.reduce((sum,line)=>sum+line.released,0);
    const unknownAmount=lines.reduce((sum,line)=>sum+line.unknownAmount,0);
    const overage=lines.reduce((sum,line)=>sum+line.overage,0);
    const committed=reserved+actual;
    return {
      id:order.id,
      purpose:order.purpose,
      version:order.version,
      budget:order.budget,
      deadline:order.deadline,
      status:order.status,
      cancelledAt:order.cancelledAt??null,
      cancelReason:order.cancelReason??null,
      createdAt:order.createdAt,
      reserved,
      actual,
      released,
      unknownAmount,
      overage,
      committed,
      available:order.budget-committed,
      lines
    };
  }

  report(){
    const orders=Object.keys(this.#store.state.orders).map(id=>this.presentOrder(id));
    const unknown=orders.flatMap(order=>order.lines
      .filter(line=>line.phase==='unknown'||line.phase==='sending')
      .map(line=>({
        orderId:order.id,
        lineId:line.id,
        entityKey:line.entityKey,
        requestId:line.requestId,
        amount:line.unknownAmount,
        phase:line.phase,
        quote:line.quote,
        sentAt:line.attempts.findLast(attempt=>attempt.action==='send')?.at??null,
        lastError:line.lastError,
        attempts:line.attempts
      })));
    const disclosures=Object.values(this.#store.state.disclosures).map(disclosure=>({
      id:disclosure.id,
      orderId:disclosure.orderId,
      lineId:disclosure.lineId,
      entityKey:disclosure.entityKey,
      purpose:disclosure.purpose,
      version:disclosure.version,
      charged:disclosure.charged,
      status:disclosure.status,
      retrievedAt:disclosure.retrievedAt,
      expiresAt:disclosure.expiresAt,
      resultSha256:disclosure.result?.sha256??null
    }));
    const totals={
      budget:orders.reduce((sum,order)=>sum+order.budget,0),
      reserved:orders.reduce((sum,order)=>sum+order.reserved,0),
      actual:orders.reduce((sum,order)=>sum+order.actual,0),
      released:orders.reduce((sum,order)=>sum+order.released,0),
      unknownAmount:orders.reduce((sum,order)=>sum+order.unknownAmount,0),
      overage:orders.reduce((sum,order)=>sum+order.overage,0)
    };
    return {generatedAt:new Date(this.#clock()).toISOString(),orders,disclosures,unknown,totals};
  }

  events(){
    return structuredClone(this.#store.state.events);
  }
}

export async function openEngine(options){return AcquisitionEngine.open(options);}
