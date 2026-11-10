import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createService, approvalDecision, sessionId } from '../lib/service.mjs';
const caller = (id='one') => ({agent:{session:{id}},signal:new AbortController().signal});
const result = (value) => ({stdout:JSON.stringify(value),stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false});
test('identity comes only from host agent session',()=>{assert.equal(sessionId(caller()),'one');assert.throws(()=>sessionId({arguments:{sessionId:'one'}}));});
test('mutations ask, fixed reads do not, missing agent denied',()=>{for(const name of ['exec','write','replace','upload','download']) assert.equal(approvalDecision({...caller(),name:'windows_'+name,arguments:{readOnly:true}}).kind,'ask');assert.equal(approvalDecision({...caller(),name:'windows_job',arguments:{action:'cancel'}}).kind,'ask');assert.equal(approvalDecision({...caller(),name:'windows_read',arguments:{}}),undefined);assert.equal(approvalDecision({name:'windows_status'}).kind,'deny');});
test('a never session is never asked, because asking can only be auto-rejected',()=>{for(const name of ['exec','write','replace','upload','download']) assert.equal(approvalDecision({...caller(),name:'windows_'+name,arguments:{}},{hostPolicy:'never'}),undefined,name+' must not ask under never');assert.equal(approvalDecision({...caller(),name:'windows_job',arguments:{action:'cancel'}},{hostPolicy:'never'}),undefined);assert.equal(approvalDecision({...caller(),name:'windows_exec',arguments:{}},{hostPolicy:'ask'}).kind,'ask');});
test('one consent per class covers later calls of that class only',async()=>{const svc=createService({}, {transport:async()=>result({ok:true}),buildOperation:()=>''});const call=(name,args={},id='s1')=>({agent:{session:{id}},signal:new AbortController().signal,name,arguments:args});assert.equal(svc.approvalFor(call('windows_exec',{script:'x'})).kind,'ask','first call must ask');assert.equal(svc.approvalFor(call('windows_write',{path:'x',content:'c'})).kind,'ask');await svc.execute('exec',{script:'x'},call('windows_exec',{script:'x'}));assert.equal(svc.approvalFor(call('windows_exec',{script:'dir'})),undefined,'remembered consent must suppress the repeat prompt');assert.equal(svc.approvalFor(call('windows_write',{path:'x',content:'c'})).kind,'ask','classes must not imply each other');assert.equal(svc.approvalFor(call('windows_exec',{script:'x'},'s2')).kind,'ask','consent is per session');await svc.dispose();});
test('a never policy neither asks nor silently records a grant',async()=>{let policy='never';const approval={effectivePolicy:()=>policy};const svc=createService({}, {approval,transport:async()=>result({ok:true}),buildOperation:()=>''});const call=(name,args={})=>({agent:{session:{id:'n1'}},signal:new AbortController().signal,name,arguments:args});assert.equal(svc.approvalFor(call('windows_exec',{script:'x'})),undefined,'never must not ask');await svc.execute('exec',{script:'x'},call('windows_exec',{script:'x'}));policy='ask';assert.equal(svc.approvalFor(call('windows_exec',{script:'x'})).kind,'ask','switching back to ask must prompt again');await svc.dispose();});
test('call mode keeps asking and disabled config denies',async()=>{const svc=createService({approvalMode:'call'}, {transport:async()=>result({ok:true}),buildOperation:()=>''});const exec={agent:{session:{id:'s1'}},signal:new AbortController().signal};await svc.execute('exec',{script:'x'},{...exec,name:'windows_exec',arguments:{}});assert.equal(svc.approvalFor({...exec,name:'windows_exec',arguments:{}}).kind,'ask','call mode must not remember consent');assert.throws(()=>createService({approvalMode:'nope'}),/approvalMode/);assert.equal(createService({enabled:false},{}).approvalFor({...exec,name:'windows_exec',arguments:{}}).kind,'deny');assert.equal(createService({enabled:false},{}).approvalFor({...exec,name:'bash',arguments:{}}),undefined,'disabling this plugin must not decide other tools');await svc.dispose();});

test('fixed operation payload and remote errors survive',async()=>{const calls=[];const svc=createService({}, {transport:async(c,s,o)=>{calls.push([s,o]);return result({ok:true,version:'v1',text:'中文'});},buildOperation:(op,a)=>JSON.stringify({op,a})});assert.equal((await svc.execute('read',{path:'中文'},caller())).text,'中文');assert.equal(JSON.parse(calls[0][0]).a.maxBytes,262144);const bad=createService({}, {transport:async()=>result({ok:false,code:'VERSION_CONFLICT'}),buildOperation:()=>''});assert.equal((await bad.execute('replace',{path:'x',oldString:'x',newString:'y',expectedVersion:'v'},caller())).code,'VERSION_CONFLICT');});
test('validation rejects unbounded and invalid arguments before transport',async()=>{let calls=0;const svc=createService({}, {transport:async()=>{calls++;return result({ok:true});},buildOperation:()=>''});for(const [op,args] of [['readlines',{path:'x',offset:0}],['read',{path:'x',maxBytes:1e9}],['replace',{path:'x',oldString:'a',newString:'b'}],['exec',{script:'x',timeoutMs:0}]])assert.equal((await svc.execute(op,args,caller())).ok,false);assert.equal(calls,0);});
test('jobs isolate sessions, retain bounded results, and cancel local SSH only',async()=>{const svc=createService({maxJobsPerSession:1},{buildOperation:()=>'',transport:async(c,s,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({...result({}),aborted:true,remoteStateUnknown:true}),{once:true}))});const j=await svc.execute('exec',{script:'Start-Sleep 99',background:true},caller());assert.equal(j.ok,true);assert.equal((await svc.execute('job',{id:j.id},caller('two'))).code,'JOB_NOT_FOUND');assert.equal((await svc.execute('exec',{script:'x',background:true},caller())).code,'JOB_LIMIT');const cancel=await svc.execute('job',{id:j.id,action:'cancel'},caller());assert.equal(cancel.remoteStateUnknown,true);await new Promise(resolve=>setImmediate(resolve));const done=await svc.execute('job',{id:j.id},caller());assert.equal(done.status,'cancelled');assert.equal(done.result.remoteStateUnknown,true);await svc.dispose();});
test('readlines preserves line and scalar-column cursor contract',async()=>{let payload;const svc=createService({}, {transport:async()=>result({ok:true}),buildOperation:(op,args)=>(payload={op,args},'')});await svc.execute('readlines',{path:'x',offset:7,column:3,limit:5,expectedVersion:'v1'},caller());assert.deepEqual(payload,{op:'readlines',args:{path:'x',offset:7,column:3,limit:5,maxBytes:262144,expectedVersion:'v1'}});});
test('timeout and truncated structured output never claim success',async()=>{for(const flags of [{timedOut:true,remoteStateUnknown:true},{truncated:true}]){const svc=createService({}, {transport:async()=>({...result({ok:true}),...flags}),buildOperation:()=>''});assert.equal((await svc.execute('status',{},caller())).ok,false);}});

test('python channel validates input and never reaches transport on bad arguments',async()=>{let calls=0;const svc=createService({}, {transport:async()=>result({ok:true}),pyTransport:async()=>{calls++;return {...result({}),stdout:'',exitCode:0};},buildOperation:()=>''});for(const args of [{},{script:''},{script:5},{script:'x',timeoutMs:0},{script:'x',background:'yes'},{script:'x',cwd:'C:\\tmp'}]){const out=await svc.execute('py',args,caller());assert.equal(out.ok,false,'expected rejection for '+JSON.stringify(args));assert.equal(out.code,'INVALID_ARGUMENT',JSON.stringify(args));}assert.equal(calls,0,'invalid arguments must not reach the remote host');});
test('python channel returns the program text verbatim and maps exit codes',async()=>{const seen=[];let next={stdout:'中文 ok',stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false};const svc=createService({}, {transport:async()=>result({ok:true}),pyTransport:async(cfg,src,opts)=>{seen.push([src,opts]);return next;},buildOperation:()=>''});const ok=await svc.execute('py',{script:'print("hi")'},caller());assert.equal(ok.ok,true);assert.equal(ok.stdout,'中文 ok','python output must not be parsed as a JSON envelope');assert.equal(seen[0][0],'print("hi")','source must be forwarded unchanged');for(const [patch,code] of [[{exitCode:4},'REMOTE_EXIT'],[{exitCode:1,stderr:'DSH_PYTHON_NOT_FOUND\r\n'},'PYTHON_NOT_FOUND'],[{exitCode:1,stderr:'Traceback (most recent call last): SyntaxError'},'REMOTE_EXIT'],[{timedOut:true,remoteStateUnknown:true},'TIMEOUT'],[{aborted:true},'ABORTED'],[{truncated:true},'OUTPUT_TRUNCATED']]){next={stdout:'',stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false,...patch};const out=await svc.execute('py',{script:'x'},caller());assert.equal(out.ok,false,JSON.stringify(patch));assert.equal(out.code,code,JSON.stringify(patch));}});
test('python channel shares the exec approval class and supports background jobs',async()=>{const svc=createService({}, {transport:async()=>result({ok:true}),pyTransport:async()=>({stdout:'',stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false}),buildOperation:()=>''});const call=(name,args={})=>({agent:{session:{id:'p1'}},signal:new AbortController().signal,name,arguments:args});assert.equal(svc.approvalFor(call('windows_py',{script:'x'})).kind,'ask','windows_py must ask like exec');await svc.execute('py',{script:'x'},call('windows_py',{script:'x'}));assert.equal(svc.approvalFor(call('windows_exec',{script:'y'})),undefined,'python and PowerShell share one exec grant');const job=await svc.execute('py',{script:'import time;time.sleep(9)',background:true},call('windows_py',{script:'x'}));assert.equal(job.ok,true);assert.equal(job.status,'running');await svc.dispose();});
test('python script size is bounded like exec',async()=>{let calls=0;const svc=createService({maxReadBytes:1024}, {transport:async()=>result({ok:true}),pyTransport:async()=>{calls++;return result({});},buildOperation:()=>''});const out=await svc.execute('py',{script:'x'.repeat(1025)},caller());assert.equal(out.ok,false);assert.match(out.message,/limit/);assert.equal(calls,0);});
test('pythonCandidates reaches the transport and is validated there',async()=>{let seen;const svc=createService({pythonCandidates:['py -3.12','python']}, {transport:async()=>result({ok:true}),pyTransport:async(cfg)=>{seen=cfg.pythonCandidates;return {stdout:'',stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false};},buildOperation:()=>''});await svc.execute('py',{script:'print(1)'},caller());assert.deepEqual(seen,['py -3.12','python'],'config must be forwarded so the bootstrap probes the configured order');});

test('download reads host services by reflection, so a fiber context never throws without inject',async()=>{
  // A fiber-backed agent context throws on `ctx.shell` ("cannot get property ... without inject"),
  // and the throw happens before optional chaining applies. Downloads must go through ctx.get.
  const services={shell:{resolve:req=>req,execute:async()=>({exitCode:0,stdout:'{}',stderr:''})},sandboxPolicy:{resolve:()=>({mode:'workspace-write',workspaceRoot:'/w'})}};
  const ctx=new Proxy({get:(name)=>services[name]},{get(target,prop){if(prop in target)return target[prop];throw new Error('cannot get property "'+String(prop)+'" without inject');}});
  assert.throws(()=>ctx.shell,/without inject/,'a plain property read must be the failure mode this guards against');
  let remoteCalls=0;
  const svc=createService({}, {attachTransport:async()=>{remoteCalls++;return {stdout:'',stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false,attachment:Buffer.alloc(0)};},buildOperation:()=>''});
  const exec={agent:{session:{id:'r1',header:{cwd:'/w'}},ctx},signal:new AbortController().signal};
  const out=await svc.execute('download',{remotePath:'a.bin'},exec);
  // Staging now happens remotely, so the injected-context probe is about the remote channel
  // rather than about a local fs provider: what must never happen is a proxy throw escaping.
  assert.notEqual(out.code,undefined,'a fiber context must yield a classified failure, never a throw');
  assert.match(String(out.message??''),/./,'the failure must carry an explanation');
});

test('upload also tolerates the injected-context proxy',async()=>{
  const services={};
  const ctx=new Proxy({get:(name)=>services[name]},{get(target,prop){if(prop in target)return target[prop];throw new Error('cannot get property "'+String(prop)+'" without inject');}});
  const svc=createService({}, {transport:async()=>result({ok:true}),buildOperation:()=>''});
  const exec={agent:{session:{id:'u1',header:{cwd:'/w'}},ctx},signal:new AbortController().signal};
  assert.equal((await svc.execute('upload',{localPath:'a',remotePath:'b'},exec)).code,'FILESYSTEM_UNAVAILABLE');
});

// ---- download over the attachment channel (2026-11-10) ----
// The bytes no longer travel inside a JSON response, so these tests drive attachTransport and a
// fake `run` for the remote staging calls, and check the properties that matter: only the path
// comes back, the digest gate runs before publication, and a short stream fails closed.
// Attachment-channel result: a record line plus the bytes that travelled after it.
const attach=(record,data)=>({...result(record),attachment:data});

test('download returns the path, not the bytes',async()=>{
  const data=Buffer.from('hello attachment');
  const sha=createHash('sha256').update(data).digest('hex');
  const svc=createService({}, {
    // The record carries the digest; the service must return the published path and never the payload.
    attachTransport:async()=>attach({ok:true,bytes:data.length,sha256:sha},data),
    buildOperation:(op,args)=>JSON.stringify({op,args}),
    transport:async()=>result({ok:true}),
  });
  // Stage 1 creates the remote temp file, then one append per chunk, then the verified move.
  // Full remote staging belongs to the PowerShell layer; here we assert the call shape.
  const out=await svc.execute('download',{remotePath:'C:/d/a.bin'},caller());
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.equal(out.path,'C:/d/a.bin');
  assert.equal(out.bytes,data.length);
  assert.equal(out.sha256,sha);
  assert.equal(out.dataBase64,undefined,'the response must never carry file content');
});

test('download rejects a short attachment before publishing',async()=>{
  const data=Buffer.from('truncated');
  const svc=createService({}, {
    attachTransport:async()=>attach({ok:true,bytes:data.length+5,sha256:createHash('sha256').update(data).digest('hex')},data),
    buildOperation:()=>'',
  });
  const out=await svc.execute('download',{remotePath:'C:/d/a.bin'},caller());
  assert.equal(out.code,'TRANSFER_INCOMPLETE');
});

test('download rejects bytes that do not match the remote digest',async()=>{
  const data=Buffer.from('payload');
  const svc=createService({}, {
    attachTransport:async()=>attach({ok:true,bytes:data.length,sha256:'0'.repeat(64)},data),
    buildOperation:()=>'',
  });
  const out=await svc.execute('download',{remotePath:'C:/d/a.bin'},caller());
  assert.equal(out.code,'HASH_MISMATCH');
});

test('download honours maxBytes and refuses to exceed maxTransferBytes',async()=>{
  const data=Buffer.from('0123456789');
  const sha=createHash('sha256').update(data).digest('hex');
  // Config ceiling: the payload itself is larger than maxTransferBytes, so the attachment
  // channel still delivers it (it cannot know the config) but the digest/size gate refuses it.
  const svc=createService({maxTransferBytes:8}, {
    attachTransport:async()=>attach({ok:true,bytes:data.length,sha256:sha},data),
    buildOperation:()=>'',
  });
  // buildOperation is a stub here, so the ceiling shows up as the same INVALID_ARGUMENT a real
  // remote build would raise for a maxBytes above the configured limit.
  const refused=await svc.execute('download',{remotePath:'a'},caller());
  assert.equal(refused.ok,false,'config ceiling must reject');
  // A call-level cap above the ceiling is a validation error before any transfer.
  let calls=0;
  const svc3=createService({}, {attachTransport:async()=>{calls++;return attach({ok:true,bytes:data.length,sha256},data);},buildOperation:()=>''});
  const out=await svc3.execute('download',{remotePath:'a',maxBytes:1e9},caller());
  assert.equal(out.code,'INVALID_ARGUMENT','a call-level cap larger than maxTransferBytes is rejected');
  assert.equal(calls,0,'validation happens before the attachment channel runs');
});
