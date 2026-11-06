import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createService, approvalDecision, sessionId, OPERATIONS } from './lib/service.mjs';
export const name='dsh-windows-ssh';
export const inject=['tools'];
export const Config=z.object({
  host:z.string().default('la2.zmal.top'), user:z.string().default('zmal'), port:z.natural().min(1).max(65535).default(20022),
  identityFile:z.string(), sshBinary:z.string().default('ssh'), connectTimeoutSeconds:z.natural().min(1).max(120).default(10),
  timeoutMs:z.natural().min(1).max(600000).default(30000),maxTimeoutMs:z.natural().min(1).max(600000).default(600000),
  maxReadBytes:z.natural().min(1024).max(1048576).default(262144),maxOutputBytes:z.natural().min(65536).max(8388608).default(1048576),
  maxTransferBytes:z.natural().min(1).max(67108864).default(16777216),maxJobsPerSession:z.natural().min(1).max(64).default(16),maxSessions:z.natural().min(1).max(1024).default(128),enabled:z.boolean().default(true),
});
const str=(description,required=false)=>({type:'string',description,...(required?{required:true}:{})});
const num=(description)=>({type:'integer',description});
const bool=(description)=>({type:'boolean',description});
const path={path:str('Remote Windows file path',true)};
const transfer={localPath:str('Local path within the session filesystem policy',true),remotePath:str('Remote Windows path',true),overwrite:bool('Explicitly allow overwrite; default false')};
const specs={
  status:['Check Windows SSH connectivity, hostname and PowerShell version.',{}],
  exec:['Execute PowerShell after host approval. Local SSH cancellation does not prove the remote process stopped.',{script:str('PowerShell script',true),cwd:str('Remote working directory'),timeoutMs:num('Positive timeout in milliseconds, capped by config'),background:bool('Start a session-owned background SSH job')}],
  read:['Read a small remote text file with a hard byte cap; oversized files require windows_readlines.',{...path,maxBytes:num('Response byte cap'),encoding:str('Strict text encoding; default UTF-8 with BOM detection')}],
  readlines:['Read a bounded remote line range. Use nextOffset/nextColumn when a long line spans pages; pass expectedVersion to detect changes.',{...path,offset:num('First line, starting at 1'),column:num('Unicode scalar column within offset line, starting at 0'),limit:num('Maximum lines, at most 2000'),maxBytes:num('Response byte cap'),encoding:str('Strict text encoding'),expectedVersion:str('Expected file fingerprint')}],
  write:['Write remote text after approval; overwrite must be explicitly true.',{...path,content:str('Text content',true),overwrite:bool('Explicit overwrite'),encoding:str('Text encoding')}],
  replace:['Replace literal text after approval; requires read fingerprint and rejects ambiguous matches or stale versions.',{...path,oldString:str('Literal text to replace',true),newString:str('Replacement text, may be empty',true),expectedVersion:str('Required fingerprint from a read',true),all:bool('Replace all matches; default false'),expectedCount:num('Required match count when supplied')}],
  upload:['Upload one bounded binary file using the session filesystem reader, stage remotely, and verify SHA256.',transfer],
  download:['Download a bounded binary file after approval; verify SHA256 and atomically publish within the session workspace.',{localPath:str('Local path inside the session workspace',true),remotePath:str('Remote Windows path',true),overwrite:bool('Explicitly allow overwrite; default false'),maxBytes:num('Maximum download bytes, capped by config')}],
  job:['List, inspect or cancel current-session SSH jobs. Cancel requires approval and remote process state remains unknown.',{id:str('Job id for get/cancel'),action:str('get (default), list, or cancel')}],
};
/** Dependency injection is an ordinary embedding seam; apply uses production dependencies. */
export function install(ctx,config={},dependencies={}) {
  const service=createService(config,dependencies);
  const logger=ctx.logger?.('windows-ssh');
  try {
    ctx.effect(()=>ctx.tools.guard(exec=>{if(!OPERATIONS.some(op=>exec.name==='windows_'+op))return; if(config.enabled===false)return 'Windows SSH tools are disabled';try{sessionId(exec);}catch(e){return e.message;}}));
    ctx.on('tools/pre-execute',async(exec,next)=>{const decision=approvalDecision(exec);if(!decision)return next();const previous=await next();return previous.kind==='allow'?decision:previous;});
    ctx.on('dispose',()=>service.dispose());
    for(const [op,[description,parameters]]of Object.entries(specs)){
      ctx.effect(()=>ctx.tools.register(defineTool({name:'windows_'+op,description,parameters,
        output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
        isConcurrencySafe:()=>['status','read','readlines','job'].includes(op),
        async execute(args,exec){return JSON.stringify(await service.execute(op,args,exec));},
      })));
    }
  } catch(e){logger?.error?.('Windows SSH activation failed: '+String(e.message??e));}
  return service;
}
export function apply(ctx,config={}) { install(ctx,config); }
