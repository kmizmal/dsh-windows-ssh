import { Jobs } from './jobs.mjs';
import { runPowerShell, runPython } from './transport.mjs';
import { transfer } from './transfers.mjs';
import { writeDownload } from './download.mjs';
import { hostService } from './host-services.mjs';
export const OPERATIONS=['status','exec','py','read','readlines','write','replace','upload','download','job'];
export function sessionId(exec) {const id=exec?.agent?.session?.id;if(typeof id!=='string'||!id)throw Object.assign(new Error('Windows tools require a host agent session'),{code:'SESSION_REQUIRED'});return id;}
/** Approval classes: one consent covers a class, and classes never imply each other. */
export const APPROVAL_CLASSES=['exec','mutate'];
/** The approval class of one call, or undefined for operations that never need consent. */
export function approvalClass(name,args={}) {
  if(name==='windows_exec'||name==='windows_py')return 'exec';
  if(['windows_write','windows_replace','windows_upload','windows_download'].includes(name))return 'mutate';
  if(name==='windows_job'&&args?.action==='cancel')return 'mutate';
  return undefined;
}
/**
* Decide one call's pre-execute outcome.
* @param exec - the pending host tool call.
* @param options.hostPolicy - the session's effective approval policy ('ask' | 'never' | undefined).
* @param options.isGranted - whether this session already granted consent for the call's class.
*/
export function approvalDecision(exec,options={}) {
  if(!OPERATIONS.some(op=>exec.name==='windows_'+op))return;
  try {sessionId(exec);}catch(e){return {kind:'deny',reason:e.message};}
  const cls=approvalClass(exec.name,exec.arguments);
  if(cls===undefined)return;
  // A 'never' session has no prompt channel at all: asking would degrade into an automatic
  // rejection, so the preset's explicit opt-out governs instead of failing closed.
  if(options.hostPolicy==='never')return;
  if(typeof options.isGranted==='function'&&options.isGranted(cls))return;
  return {kind:'ask',reason:'Approve '+exec.name+' for this host session. Cancelling SSH does not prove the remote process stopped.'};
}
function text(v,name,empty=false) {if(typeof v!=='string'||(!empty&&!v.length)||v.includes('\0'))throw new TypeError(name+' must be '+(empty?'a':'a nonempty')+' string without NUL');return v;}
function integer(v,name,min,max) {if(!Number.isSafeInteger(v)||v<min||v>max)throw new TypeError(name+' must be an integer from '+min+' to '+max);return v;}
const fail=(code,message,rest={})=>({ok:false,code,message,...rest});
export function createService(config={}, dependencies={}) {
  const cfg={host:'la2.zmal.top',user:'zmal',port:20022,timeoutMs:30000,maxTimeoutMs:600000,maxReadBytes:262144,maxOutputBytes:1048576,maxTransferBytes:16777216,maxJobsPerSession:16,maxSessions:128,approvalMode:'session',...config};
  if(cfg.approvalMode!=='session'&&cfg.approvalMode!=='call')throw new TypeError('approvalMode must be "session" or "call"');
  const jobs=new Jobs(cfg), transport=dependencies.transport??runPowerShell, pyTransport=dependencies.pyTransport??runPython;
  const build=dependencies.buildOperation??(async(op,args)=>(await import('./scripts.mjs')).buildOperation(op,args));
  // Consent already shown in this session, per approval class. A tool body only runs after the
  // pre-execute gate passed, so the body records the grant instead of the gate.
  const grants=new Map();
  function grantsFor(id) {
    if(cfg.approvalMode==='call')return undefined;
    let set=grants.get(id);
    if(set===undefined){if(grants.size>=cfg.maxSessions)grants.delete(grants.keys().next().value);set=new Set();grants.set(id,set);}
    return set;
  }
  function hostPolicy(exec) {
    const approval=dependencies.approval??exec?.agent?.ctx?.get?.('approval');
    try {return approval?.effectivePolicy?.(exec?.agent?.session);} catch {return undefined;}
  }
  async function run(script,signal,timeoutMs,structured=true) {
    const r=await transport(cfg,script,{signal,timeoutMs});
    if(r.timedOut||r.aborted||r.exitCode!==0||(structured&&r.truncated))return fail(r.timedOut?'TIMEOUT':r.aborted?'ABORTED':r.truncated?'OUTPUT_TRUNCATED':'REMOTE_EXIT','SSH/PowerShell operation did not complete successfully',r);
    if(!structured)return {ok:true,...r};
    try {const value=JSON.parse(r.stdout.replace(/^\uFEFF/,''));if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.ok!=='boolean')throw new Error('Expected object with ok');return {...value,transport:{stderr:r.stderr,exitCode:r.exitCode,timedOut:r.timedOut,aborted:r.aborted,truncated:r.truncated,remoteStateUnknown:r.remoteStateUnknown}};}catch{return fail('INVALID_REMOTE_RESPONSE','Remote response was not a complete JSON object',r);}
  }
  // The python channel returns the program's own text, not a plugin JSON envelope, so it can
  // never be parsed the way helper responses are.
  //
  // Exit code 127 cannot be used to detect a missing interpreter: Windows OpenSSH runs the
  // remote shell as pwsh, and any *nested* pwsh collapses every nonzero exit to 1 (measured:
  // `exit 42`, `exit 127`, `sys.exit(4)` all arrive as 1; only 0 survives). The bootstrap's
  // stderr sentinel is therefore the only reliable evidence that no interpreter was found.
  async function runPy(source,signal,timeoutMs) {
    const r=await pyTransport(cfg,source,{signal,timeoutMs});
    if(r.timedOut||r.aborted||r.truncated||r.exitCode!==0) {
      const missing=typeof r.stderr==='string'&&r.stderr.includes('DSH_PYTHON_NOT_FOUND');
      const code=r.timedOut?'TIMEOUT':r.aborted?'ABORTED':r.truncated?'OUTPUT_TRUNCATED':missing?'PYTHON_NOT_FOUND':'REMOTE_EXIT';
      const message=code==='PYTHON_NOT_FOUND'
        ?'No usable Python interpreter was found on the remote host'
        :'SSH/Python operation did not complete successfully';
      return fail(code,message,r);
    }
    return {ok:true,...r};
  }
  return {
    /** The pre-execute decision for one call, including this session's remembered consent. */
    approvalFor(exec) {
      // The listener fires for every host tool, so an unrelated name must stay untouched
      // even when this plugin is disabled.
      if(!OPERATIONS.some(op=>exec?.name==='windows_'+op))return;
      if(cfg.enabled===false)return {kind:'deny',reason:'Windows SSH tools are disabled'};
      const id=exec?.agent?.session?.id;
      return approvalDecision(exec,{hostPolicy:hostPolicy(exec),isGranted:cls=>typeof id==='string'&&grants.get(id)?.has(cls)===true});
    },
    async execute(op,args={},exec={}) {
      try {
        const owner=sessionId(exec);if(!OPERATIONS.includes(op))throw new TypeError('Unknown operation');if(exec.signal?.aborted)return fail('ABORTED','Caller cancelled before dispatch');
        // Reaching the body proves the pre-execute gate was satisfied, so the class is now
        // granted for this session — except under a 'never' policy, where nothing was asked
        // and therefore nothing may be remembered if the user later switches back to 'ask'.
        const cls=approvalClass('windows_'+op,args);if(cls!==undefined&&hostPolicy(exec)!=='never')grantsFor(owner)?.add(cls);
        const timeoutMs=integer(args.timeoutMs??cfg.timeoutMs,'timeoutMs',1,cfg.maxTimeoutMs);
        if(op==='job') {const action=args.action??'get';if(!['get','list','cancel'].includes(action))throw new TypeError('Invalid job action');if(action!=='list')text(args.id,'id');return jobs.query(owner,args.id,action);}
        if(op==='download') {
          text(args.remotePath,'remotePath');text(args.localPath,'localPath');
          const shell=dependencies.shell??hostService(exec.agent?.ctx,'shell'), fs=dependencies.fs??hostService(exec.agent?.ctx,'fs');
          if(!shell?.resolve||!shell?.execute)return fail('SHELL_UNAVAILABLE','Host has no sandbox-enforced shell executor');
          if(!fs?.resolve||!fs?.processPath||!fs?.contains)return fail('FILESYSTEM_UNAVAILABLE','Host has no sandbox-aware filesystem');
          // The file travels base64 inside one JSON response, so the transport's shared
          // output budget, not just maxTransferBytes, bounds a single download.
          const cap=Math.min(cfg.maxTransferBytes,Math.floor(cfg.maxOutputBytes*3/4)-4096);
          const maxBytes=integer(args.maxBytes??cap,'maxBytes',1,cap);
          const response=await run(await build('download',{path:args.remotePath,maxBytes}),exec.signal,timeoutMs);if(!response.ok)return response;
          return await writeDownload(args.localPath,{...response,overwrite:args.overwrite===true},exec,shell,fs,maxBytes);
        }
        if(op==='upload')return await transfer(args,exec,cfg,(s)=>run(s,exec.signal,timeoutMs),dependencies.fs??hostService(exec.agent?.ctx,'fs'));
        if(op==='exec') {
          text(args.script,'script');if(Buffer.byteLength(args.script)>cfg.maxReadBytes)throw new TypeError('script exceeds limit');if(args.background!==undefined&&typeof args.background!=='boolean')throw new TypeError('background must be boolean');
          let script=args.script;if(args.cwd!==undefined){text(args.cwd,'cwd');const cwd=Buffer.from(args.cwd).toString('base64');script="Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+cwd+"'))) -ErrorAction Stop\n"+script;}
          if(args.background)return jobs.start(owner,signal=>run(script,signal,timeoutMs,false));return await run(script,exec.signal,timeoutMs,false);
        }
        if(op==='py') {
          // Same limits as exec and the same rule: the program is data on stdin, never source
          // spliced into a command line. `cwd` is deliberately unsupported here, because a
          // python program's directory belongs to the program (os.chdir), not to the transport.
          text(args.script,'script');if(Buffer.byteLength(args.script)>cfg.maxReadBytes)throw new TypeError('script exceeds limit');if(args.background!==undefined&&typeof args.background!=='boolean')throw new TypeError('background must be boolean');
          if(args.cwd!==undefined)throw new TypeError('cwd is not supported by windows_py; call os.chdir in the program');
          if(args.background)return jobs.start(owner,signal=>runPy(args.script,signal,timeoutMs));return await runPy(args.script,exec.signal,timeoutMs);
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
