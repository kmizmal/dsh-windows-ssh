import { createHash, randomUUID } from 'node:crypto';
export const q=s=>"'"+s.replaceAll("'","''")+"'";
export const reply=body=>"$ErrorActionPreference='Stop'; try { "+body+" } catch { @{ok=$false;code='TRANSFER_ERROR';message=$_.Exception.Message}|ConvertTo-Json -Compress }";
/** Upload only through the caller's sandbox-aware filesystem provider. No node:fs fallback. */
export async function transfer(args,exec,config,run,fs) {
  if(!fs?.resolve||!fs?.readBytes||!fs?.stat)return {ok:false,code:'FILESYSTEM_UNAVAILABLE',message:'Caller has no sandbox-aware binary reader'};
  for(const key of ['localPath','remotePath'])if(typeof args[key]!=='string'||!args[key]||args[key].includes('\0'))throw new TypeError(key+' must be a nonempty path');
  if(args.overwrite!==undefined&&typeof args.overwrite!=='boolean')throw new TypeError('overwrite must be boolean');
  const target=await fs.resolve(args.localPath,{cwd:exec.agent.session.header?.cwd,signal:exec.signal});
  const info=await fs.stat(target,exec.signal);
  if(!info||info.type!=='file')return {ok:false,code:'NOT_FILE',message:'Upload source must be a regular file'};
  if(info.size>config.maxTransferBytes)return {ok:false,code:'TRANSFER_LIMIT',message:'Upload exceeds configured byte limit'};
  const bytes=Buffer.from(await fs.readBytes(target,exec.signal,config.maxTransferBytes));
  if(bytes.length>config.maxTransferBytes)return {ok:false,code:'TRANSFER_LIMIT',message:'Upload exceeds configured byte limit'};
  const after=await fs.stat(target,exec.signal);if(after?.version!==info.version)return {ok:false,code:'LOCAL_VERSION_CONFLICT',message:'Upload source changed during read'};
  const hash=createHash('sha256').update(bytes).digest('hex');
  const dest=q(args.remotePath), temp=q(args.remotePath+'.dsh-'+randomUUID()+'.tmp');
  let begun=false;
  try {
    let r=await run(reply("$p="+dest+"; $t="+temp+"; if((Test-Path -LiteralPath $p) -and $"+(args.overwrite===true?'false':'true')+"){throw 'Destination exists; explicit overwrite required'}; $f=[IO.File]::Open($t,[IO.FileMode]::CreateNew);$f.Dispose();@{ok=$true}|ConvertTo-Json -Compress"));if(!r.ok)return r;begun=true;
    for(let offset=0;offset<bytes.length;offset+=12288){if(exec.signal?.aborted)return {ok:false,code:'ABORTED',remoteStateUnknown:true};const b64=bytes.subarray(offset,offset+12288).toString('base64');r=await run(reply("$f=[IO.File]::Open("+temp+",[IO.FileMode]::Append);try{$b=[Convert]::FromBase64String('"+b64+"');$f.Write($b,0,$b.Length)}finally{$f.Dispose()};@{ok=$true}|ConvertTo-Json -Compress"));if(!r.ok)return r;}
    return await run(reply("$t="+temp+";$p="+dest+";$h=(Get-FileHash -LiteralPath $t -Algorithm SHA256).Hash.ToLowerInvariant();if($h -ne '"+hash+"'){throw 'SHA256 mismatch'};[IO.File]::Move($t,$p,$"+(args.overwrite===true?'true':'false')+");@{ok=$true;bytes="+bytes.length+";sha256=$h;path=$p}|ConvertTo-Json -Compress"));
  } finally {
    // Cleanup shares caller cancellation; cancellation may prevent cleanup. Never claim otherwise.
    if(begun&&!exec.signal?.aborted)try{await run(reply("if(Test-Path -LiteralPath "+temp+"){[IO.File]::Delete("+temp+")};@{ok=$true}|ConvertTo-Json -Compress"));}catch{}
  }
}
