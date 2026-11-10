import { createHash, randomUUID } from 'node:crypto';
import { reply, q } from './transfers.mjs';

const failure=(code,message,extra={})=>({ok:false,code,message,...extra});
// Same chunk size the upload path uses: base64 in a command line, 4/3 of 12288 is exactly 16384
// characters, which keeps every write well under the CreateProcess command-line ceiling.
const STAGING_CHUNK = 12288;

/**
 * Publish a downloaded attachment: stream the bytes into a remote temp file behind the target,
 * then let the remote side verify the SHA256 and move it into place.
 *
 * Why remote-side staging instead of writing locally: the destination may not be reachable from
 * this host, the sandboxed local write path is exactly what a download is trying to avoid, and
 * the remote is the only party that can prove the file it produced is the file that lands. The
 * publish stays atomic for the same reason an upload does - one verified move, never a partial
 * file at the destination path.
 */
export async function writeDownload(remotePath,record,data,exec,cfg,run){
  if(!record||typeof record!=='object')return failure('INVALID_REMOTE_RESPONSE','Remote download returned no record');
  if(!Buffer.isBuffer(data))return failure('INVALID_REMOTE_RESPONSE','Remote download returned no attachment bytes');
  if(typeof record.sha256!=='string'||!/^[0-9a-f]{64}$/i.test(record.sha256))return failure('INVALID_REMOTE_RESPONSE','Remote download returned no digest');
  // A truncated stream (dropped connection, killed SSH child) shows up as a length disagreement
  // here instead of as a silently short file.
  if(typeof record.bytes!=='number'||record.bytes!==data.length)return failure('TRANSFER_INCOMPLETE','Attachment length did not match the remote record');
  const local=createHash('sha256').update(data).digest('hex');
  if(local!==record.sha256.toLowerCase())return failure('HASH_MISMATCH','Downloaded bytes did not match the remote digest');
  if(exec.signal?.aborted)return failure('ABORTED','Caller cancelled before staging');

  const temp=remotePath+'.dsh-'+randomUUID()+'.part';
  const head=q(temp);
  const tail=q(remotePath);
  // PowerShell has $true/$false, not the JavaScript spellings: `-not false` and
  // `::Move($t,$p,false)` both fail to parse. The value is assigned to a variable instead.
  const overwrite=record.overwrite===true?'$true':'$false';
  let begun=false;
  try{
    let r=await run(reply(
      "$t="+head+";$p="+tail+";"+
      "$ow="+overwrite+";"+
      "if((Test-Path -LiteralPath $p) -and (-not $ow)){throw 'Destination exists; explicit overwrite required'};"+
      "if(-not (Test-Path -LiteralPath (Split-Path -Parent $t))){throw 'Destination directory does not exist'};"+
      "$f=[IO.File]::Open($t,[IO.FileMode]::CreateNew);$f.Dispose();@{ok=$true}|ConvertTo-Json -Compress"));
    if(!r.ok)return r;
    begun=true;
    for(let offset=0;offset<data.length;offset+=STAGING_CHUNK){
      if(exec.signal?.aborted)return failure('ABORTED','Cancelled while staging the download',{remoteStateUnknown:true});
      const b64=data.subarray(offset,offset+STAGING_CHUNK).toString('base64');
      r=await run(reply("$f=[IO.File]::Open("+head+",[IO.FileMode]::Append);try{$b=[Convert]::FromBase64String('"+b64+"');$f.Write($b,0,$b.Length)}finally{$f.Dispose()};@{ok=$true}|ConvertTo-Json -Compress"));
      if(!r.ok)return r;
    }
    return await run(reply(
      "$t="+head+";$p="+tail+";"+
      "$h=(Get-FileHash -LiteralPath $t -Algorithm SHA256).Hash.ToLowerInvariant();"+
      "if($h -ne '"+record.sha256.toLowerCase()+"'){throw 'SHA256 mismatch'};"+
      // Move(..., overwrite) is .NET Core only; Windows PowerShell 5.1 throws on three args,
      // so replace explicitly and fall back to Move only when the destination is absent.
      // Replace needs NULL for the backup argument, and `Move(...,$true)` is .NET Core only
      // (Windows PowerShell 5.1 rejects the three-argument overload). Delete first, then move.
      "if($ow){if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force}};"+
      "[IO.File]::Move($t,$p);"+
      "@{ok=$true;path=$p;bytes=(Get-Item -LiteralPath $p).Length;sha256=$h}|ConvertTo-Json -Compress"));
  } finally {
    // Cleanup shares caller cancellation; cancellation may prevent cleanup. Never claim otherwise.
    if(begun&&!exec.signal?.aborted)try{await run(reply("if(Test-Path -LiteralPath "+head+"){[IO.File]::Delete("+head+")};@{ok=$true}|ConvertTo-Json -Compress"));}catch{}
  }
}
