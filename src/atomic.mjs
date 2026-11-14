import {mkdir, open, rename, rm} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

async function syncDirectory(directory){
  let handle;
  try{
    handle=await open(directory,'r');
    await handle.sync();
  }catch(error){
    // Some filesystems do not permit fsync on a directory. The file itself is
    // still fsynced; this is a best-effort durability enhancement.
    if(!['EINVAL','ENOTSUP','EISDIR','EPERM'].includes(error.code))throw error;
  }finally{
    await handle?.close().catch(()=>{});
  }
}

/** Write a small file durably: fsync temp file, atomic rename, fsync dir. */
export async function writeFileAtomic(path,data,mode=0o600){
  const target=resolve(path);
  const directory=dirname(target);
  await mkdir(directory,{recursive:true});
  const temporary=`${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle=await open(temporary,'w',mode);
  try{
    await handle.writeFile(data);
    await handle.sync();
  }finally{
    await handle.close();
  }
  try{
    await rename(temporary,target);
  }catch(error){
    await rm(temporary,{force:true}).catch(()=>{});
    throw error;
  }
  await syncDirectory(directory);
}
