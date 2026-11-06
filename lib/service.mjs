import { Jobs } from './jobs.mjs';
import { runPowerShell } from './transport.mjs';
import { transfer } from './transfers.mjs';
import { writeDownload } from './download.mjs';
export const OPERATIONS=['status','exec','read','readlines','write','replace','upload','download','job'];
export function sessionId(exec) {const id=exec?.agent?.session?.id;if(typeof id!=='string'||!id)throw Object.assign(new Error('Windows tools require a host agent session'),{code:'SESSION_REQUIRED'});return id;}
export function approvalDecision(exec) {
  if(!OPERATIONS.some(op=>exec.name==='windows_'+op))return;
  try {sessionId(exec);}catch(e){return {kind:'deny',reason:e.message};}
  if(['windows_exec','windows_write','windows_replace','windows_upload','windows_download'].includes(exec.name)||(exec.name==='windows_job'&&exec.arguments?.action==='cancel'))return {kind:'ask',reason:'Approve '+exec.name+' for this host session. Cancelling SSH does not prove the remote process stopped.'};
}
function text(v,name,empty=false) {if(typeof v!=='string'||(!empty&&!v.length)||v.includes('\0'))throw new TypeError(name+' must be '+(empty?'a':'a nonempty')+' string without NUL');return v;}
function integer(v,name,min,max) {if(!Number.isSafeInteger(v)||v<min||v>max)throw new TypeError(name+' must be an integer from '+min+' to '+max);return v;}
const fail=(code,message,rest={})=>({ok:false,code,message,...rest});
export function createService(config={}, dependencies={}) {
  const cfg={host:'la2.zmal.top',user:'zmal',port:20022,timeoutMs:30000,maxTimeoutMs:600000,maxReadBytes:262144,maxOutputBytes:1048576,maxTransferBytes:16777216,maxJobsPerSession:16,maxSessions:128,...config};
  const jobs=new Jobs(cfg), transport=dependencies.transport??runPowerShell;
  const build=dependencies.buildOperation??(async(op,args)=>(await import('./scripts.mjs')).buildOperation(op,args));
  async function run(script,signal,timeoutMs,structured=true) {
    const r=await transport(cfg,script,{signal,timeoutMs});
    if(r.timedOut||r.aborted||r.exitCode!==0||(structured&&r.truncated))return fail(r.timedOut?'TIMEOUT':r.aborted?'ABORTED':r.truncated?'OUTPUT_TRUNCATED':'REMOTE_EXIT','SSH/PowerShell operation did not complete successfully',r);
    if(!structured)return {ok:true,...r};
    try {const value=JSON.parse(r.stdout.replace(/^\uFEFF/,''));if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.ok!=='boolean')throw new Error('Expected object with ok');return {...value,transport:{stderr:r.stderr,exitCode:r.exitCode,timedOut:r.timedOut,aborted:r.aborted,truncated:r.truncated,remoteStateUnknown:r.remoteStateUnknown}};}catch{return fail('INVALID_REMOTE_RESPONSE','Remote response was not a complete JSON object',r);}
  }
  return {
    async execute(op,args={},exec={}) {
      try {
        const owner=sessionId(exec);if(!OPERATIONS.includes(op))throw new TypeError('Unknown operation');if(exec.signal?.aborted)return fail('ABORTED','Caller cancelled before dispatch');
        const timeoutMs=integer(args.timeoutMs??cfg.timeoutMs,'timeoutMs',1,cfg.maxTimeoutMs);
        if(op==='job') {const action=args.action??'get';if(!['get','list','cancel'].includes(action))throw new TypeError('Invalid job action');if(action!=='list')text(args.id,'id');return jobs.query(owner,args.id,action);}
        if(op==='download') {
          text(args.remotePath,'remotePath');text(args.localPath,'localPath');
          const shell=dependencies.shell??exec.agent?.ctx?.shell, fs=dependencies.fs??exec.agent?.ctx?.fs;
          if(!shell?.resolve||!shell?.execute)return fail('SHELL_UNAVAILABLE','Host has no sandbox-enforced shell executor');
          if(!fs?.resolve||!fs?.processPath||!fs?.contains)return fail('FILESYSTEM_UNAVAILABLE','Host has no sandbox-aware filesystem');
          // The file travels base64 inside one JSON response, so the transport's shared
          // output budget, not just maxTransferBytes, bounds a single download.
          const cap=Math.min(cfg.maxTransferBytes,Math.floor(cfg.maxOutputBytes*3/4)-4096);
          const maxBytes=integer(args.maxBytes??cap,'maxBytes',1,cap);
          const response=await run(await build('download',{path:args.remotePath,maxBytes}),exec.signal,timeoutMs);if(!response.ok)return response;
          return await writeDownload(args.localPath,{...response,overwrite:args.overwrite===true},exec,dependencies.shell??exec.agent?.ctx?.shell,dependencies.fs??exec.agent?.ctx?.fs,maxBytes);
        }
        if(op==='upload')return await transfer(args,exec,cfg,(s)=>run(s,exec.signal,timeoutMs),dependencies.fs??exec.agent?.ctx?.fs);
        if(op==='exec') {
          text(args.script,'script');if(Buffer.byteLength(args.script)>cfg.maxReadBytes)throw new TypeError('script exceeds limit');if(args.background!==undefined&&typeof args.background!=='boolean')throw new TypeError('background must be boolean');
          let script=args.script;if(args.cwd!==undefined){text(args.cwd,'cwd');const cwd=Buffer.from(args.cwd).toString('base64');script="Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+cwd+"'))) -ErrorAction Stop\n"+script;}
          if(args.background)return jobs.start(owner,signal=>run(script,signal,timeoutMs,false));return await run(script,exec.signal,timeoutMs,false);
        }
        const a={...args};delete a.timeoutMs;
        if(op!=='status')text(a.path,'path');
        if(['read','readlines'].includes(op)){a.maxBytes=integer(a.maxBytes??cfg.maxReadBytes,'maxBytes',1,cfg.maxReadBytes);if(a.encoding!==undefined)text(a.encoding,'encoding');}
        if(op==='readlines'){a.offset=integer(a.offset??1,'offset',1,Number.MAX_SAFE_INTEGER);a.column=integer(a.column??0,'column',0,Number.MAX_SAFE_INTEGER);a.limit=integer(a.limit??200,'limit',1,2000);if(a.expectedVersion!==undefined)text(a.expectedVersion,'expectedVersion');}
        if(op==='write'){text(a.content,'content',true);if(Buffer.byteLength(a.content)>cfg.maxReadBytes)throw new TypeError('content exceeds limit');if(a.overwrite!==undefined&&typeof a.overwrite!=='boolean')throw new TypeError('overwrite must be boolean');a.overwrite=a.overwrite===true;}
        if(op==='replace'){text(a.oldString,'oldString');text(a.newString,'newString',true);text(a.expectedVersion,'expectedVersion');if(Buffer.byteLength(a.oldString)+Buffer.byteLength(a.newString)>cfg.maxReadBytes)throw new TypeError('replacement exceeds limit');if(a.all!==undefined&&typeof a.all!=='boolean')throw new TypeError('all must be boolean');a.all=a.all===true;if(a.expectedCount!==undefined)integer(a.expectedCount,'expectedCount',1,Number.MAX_SAFE_INTEGER);}
        const result=await run(await build(op,a),exec.signal,timeoutMs);if(result.ok===false&&result.error&&typeof result.error==='object')return fail(result.error.code??'REMOTE_ERROR',result.error.message??'Remote operation failed',{details:result.error.details});return result;
      } catch(e) {return fail(e.code??'INVALID_ARGUMENT',String(e.message??e));}
    },
    dispose:()=>jobs.dispose(),
  };
}
