import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {writeFileAtomic} from './atomic.mjs';

export const LEDGER_SCHEMA=1;

export function emptyLedger(){
  return {schema:LEDGER_SCHEMA,sequence:0,orders:{},lines:{},disclosures:{},events:[]};
}

function normaliseLedger(value){
  if(!value||typeof value!=='object'||value.schema!==LEDGER_SCHEMA){
    throw new Error('账本格式无效：不支持的 schema');
  }
  const ledger=emptyLedger();
  ledger.sequence=Number.isInteger(value.sequence)&&value.sequence>=0?value.sequence:0;
  for(const key of ['orders','lines','disclosures']){
    if(value[key]!==undefined&&value[key]!==null&&typeof value[key]!=='object')throw new Error(`账本格式无效：${key}`);
    ledger[key]={...(value[key]??{})};
  }
  if(!Array.isArray(value.events))throw new Error('账本格式无效：events');
  ledger.events=value.events;
  return ledger;
}

/**
 * Durable JSON ledger with a serialised transaction queue.
 *
 * Every update mutates a clone, writes it atomically, and only then publishes
 * it in memory. A rejected mutator (for example a budget check) writes nothing.
 * Serialising updates means two concurrent workers/reservations cannot both
 * spend the same remaining budget.
 */
export class LedgerStore{
  #queue=Promise.resolve();
  #path;

  constructor(path){
    this.#path=resolve(path);
    this.state=emptyLedger();
  }

  get path(){return this.#path;}

  async load(){
    try{
      this.state=normaliseLedger(JSON.parse(await readFile(this.#path,'utf8')));
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      this.state=emptyLedger();
      // Materialise the ledger early so operators can see where state lives.
      await writeFileAtomic(this.#path,JSON.stringify(this.state,null,2)+'\n');
    }
    return this.state;
  }

  async update(mutator){
    const operation=this.#queue.then(async()=>{
      const draft=structuredClone(this.state);
      const result=await mutator(draft);
      await writeFileAtomic(this.#path,JSON.stringify(draft,null,2)+'\n');
      this.state=draft;
      return result;
    });
    this.#queue=operation.then(()=>undefined,()=>undefined);
    return operation;
  }
}

export function nextEvent(draft,type,fields={}){
  draft.sequence+=1;
  const event={sequence:draft.sequence,at:fields.at??new Date().toISOString(),type,...fields};
  draft.events.push(event);
  return event;
}
