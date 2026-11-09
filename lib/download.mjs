import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { hostService } from './host-services.mjs';

const failure=(code,message,extra={})=>({ok:false,code,message,...extra});

export async function writeDownload(localPath,response,exec,shell,fs,maxBytes){
  if(!shell?.resolve||!shell?.execute)return failure('SHELL_UNAVAILABLE','Host has no sandbox-enforced shell executor');
  if(!fs?.resolve||!fs?.processPath||!fs?.contains)return failure('FILESYSTEM_UNAVAILABLE','Host filesystem cannot resolve a sandboxed download target');
  if(!exec.agent?.session||typeof exec.agent.session.header?.cwd!=='string')return failure('SESSION_REQUIRED','Download needs the session workspace');
  if(typeof response.dataBase64!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.dataBase64))return failure('INVALID_REMOTE_RESPONSE','Remote download returned invalid base64');
  const bytes=Buffer.from(response.dataBase64,'base64');
  if(bytes.length!==(response.bytes??bytes.length)||bytes.length>maxBytes)return failure('TRANSFER_LIMIT','Remote download size exceeded its validated limit');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(typeof response.sha256!=='string'||response.sha256.toLowerCase()!==sha256)return failure('HASH_MISMATCH','Remote download SHA256 did not match');
  if(exec.signal?.aborted)return failure('ABORTED','Caller cancelled before local publication');
  const workspace=exec.agent.session.header.cwd;
  const policy=hostService(exec.agent?.ctx,'sandboxPolicy')?.resolve?.({session:exec.agent.session});
  if(!policy)return failure('SANDBOX_POLICY_UNAVAILABLE','Host did not provide a resolved filesystem sandbox policy');
  const target=await fs.resolve(localPath,{cwd:workspace,signal:exec.signal});
  const root=await fs.resolve(workspace,{cwd:workspace,signal:exec.signal});
  if(!fs.contains(root,target))return failure('SANDBOX_PATH_DENIED','Download target is outside this session workspace');
  const destination=fs.processPath(target);
  if(typeof destination!=='string'||!path.isAbsolute(destination))return failure('FILESYSTEM_UNAVAILABLE','Host did not return an absolute process path');
  const stdin=JSON.stringify({destination,temp:destination+'.dsh-'+randomUUID()+'.tmp',dataBase64:response.dataBase64,sha256,overwrite:response.overwrite===true});
  const source="const fs=require('node:fs'),c=require('node:crypto');let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>{let a=JSON.parse(d),b=Buffer.from(a.dataBase64,'base64'),h=c.createHash('sha256').update(b).digest('hex');if(h!==a.sha256)throw Error('SHA256 mismatch');if(!a.overwrite&&fs.existsSync(a.destination))throw Error('Destination exists');let fd=fs.openSync(a.temp,'wx',0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}try{if(a.overwrite)fs.renameSync(a.temp,a.destination);else{fs.linkSync(a.temp,a.destination);fs.unlinkSync(a.temp)}}catch(e){try{fs.unlinkSync(a.temp)}catch{};throw e}process.stdout.write(JSON.stringify({bytes:b.length,sha256:h}))})";
  const command='node -e '+JSON.stringify(source);
  let spec;try{spec=shell.resolve({command,stdin,signal:exec.signal,timeoutMs:30000,stdoutMaxBytes:4096,sandboxPolicy:policy});}catch(e){return failure('SANDBOX_DENIED',String(e.message??e));}
  const result=await shell.execute(spec);
  if(result.aborted||exec.signal?.aborted)return failure('ABORTED','Local download publication was interrupted',{localStateUnknown:true});
  if(result.exitCode!==0)return failure('LOCAL_WRITE_FAILED',result.stderr||'Sandboxed local file publication failed');
  let published;try{published=JSON.parse(result.stdout);}catch{return failure('LOCAL_WRITE_FAILED','Local publisher returned no valid result');}
  return {ok:true,path:localPath,bytes:published.bytes,sha256:published.sha256};
}
