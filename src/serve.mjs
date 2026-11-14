import {createSource} from './source.mjs';
import {startServer} from './console.mjs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const host=process.env.HOST??'127.0.0.1';
const sourcePort=Number(process.env.PORT??0);
const consolePort=Number(process.env.CONSOLE_PORT??0);
const ledgerPath=process.env.LEDGER_PATH??join(process.env.LOCAL_DIR??'.local','ledger.json');

const source=await createSource({port:sourcePort,host});
const consoleServer=await startServer({host,port:consolePort,sourceUrl:source.url,ledgerPath});

console.log(JSON.stringify({
  source:source.url,
  console:consoleServer.url,
  ledger:consoleServer.engine.ledgerPath,
  status:'来源与采购控制台就绪'
}));

let stopping=false;
async function stop(){
  if(stopping)return;
  stopping=true;
  await Promise.allSettled([consoleServer.close(),source.close()]);
  process.exit(0);
}
process.on('SIGTERM',stop);
process.on('SIGINT',stop);

// Exported only so the startup test can observe the same composition.
export {source,consoleServer};
