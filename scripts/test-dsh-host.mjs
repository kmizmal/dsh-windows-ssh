import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire,registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.env.DSH_HOST_MODULE_ROOT??'/root/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules';
const hostURL=pathToFileURL(path.join(root,'host-test.mjs')).href;
const requireHost=createRequire(hostURL);
const load=name=>import(pathToFileURL(requireHost.resolve(name)).href);
registerHooks({resolve(specifier,context,next){return next(specifier,specifier.startsWith('@deepseek-ai/')?{...context,parentURL:hostURL}:context);}});
const [{Context,Service},{ToolRuntime,assertSupportedJsonSchema},boot,nativeExecutor,plugin]=await Promise.all([
 load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-tools'),load('@deepseek-ai/dsh-app-boot'),
 // dsh >= 0.2.2 requires a mounted tool executor; without one tools.execute() throws
 // ToolExecutorUnavailableError before any plugin code runs.
 load('@deepseek-ai/dsh-tool-executor-native'),import('../index.js')]);
class Prompt extends Service {constructor(ctx){super(ctx,'systemPrompt');}tools(){return ()=>{};}section(){return ()=>{};}assemble(){return {sections:[],contexts:[],tools:[],variables:{}};}}
/** Stands in for dsh-user-approval: answers 'allowed-once' and counts how often it was asked. */
class Approval extends Service {
  constructor(ctx){super(ctx,'approval');this.asked=[];}
  effectivePolicy(){return 'ask';}
  async request(req){this.asked.push(req.toolName);return 'allowed-once';}
}
const ctx=new Context();let calls=0;let remoteCalls=0;
const agent={session:{id:'fixture-session',header:{cwd:'/tmp'}},get ctx(){return ctx;}};
// dsh >= 0.2.2 executes a *batch*: arguments travel as a JSON string and results come back
// keyed by callId. The single-call shape this fixture used before no longer exists.
// `actor: null` deliberately means "no agent": an explicit `undefined` would fall back to the
// default parameter and quietly supply one.
const call=async(name,args={},actor=agent)=>{
 const callId='fixture-'+(++calls);
 const settlement=await ctx.tools.execute({calls:[{id:callId,name,arguments:JSON.stringify(args)}],
  ...(actor===null?{}:{agent:actor}),signal:new AbortController().signal});
 const entry=settlement.results.find(r=>r.callId===callId);
 assert.ok(entry,'batch result is missing '+callId+': '+JSON.stringify(settlement.results));
 const r=entry.result;
 return {r,value:r.isError?undefined:JSON.parse(r.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'))};};
let fiber;
try {
 await ctx.plugin(Prompt).await();await ctx.plugin(ToolRuntime).await();await ctx.plugin(nativeExecutor).await();
 const manifest=boot.readProfileManifest('compat',path.resolve(import.meta.dirname,'..'));
 assert.equal(manifest.name,'dsh-windows-ssh');assert.equal(boot.evaluatePluginCompatibility(manifest),undefined);
 const entries=boot.composeEntries([boot.bundlePatchPaths(path.resolve(import.meta.dirname,'..'),manifest.dsh.bundle).flatMap(file=>boot.loadOverlayPatches('compat',file))]);assert.equal(entries[0].name,'dsh-windows-ssh');
 fiber=ctx.plugin({name:'windows-fixture',inject:['tools'],apply(context){plugin.install(context,{}, {buildOperation:(op,args)=>JSON.stringify({op,args}),transport:async()=>{remoteCalls++;return {stdout:JSON.stringify({ok:true,host:'FAKE-WINDOWS',text:'中文',version:'v1'}),stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false};},pyTransport:async()=>{remoteCalls++;return {stdout:'PY中文',stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false};}});}});await fiber.await();
 assert.equal(ctx.tools.schemas().length,10);assert.ok(ctx.tools.schemas().some(s=>s.name==='windows_py'),'windows_py must be registered');for(const s of ctx.tools.schemas())assertSupportedJsonSchema(s.parameters);
 const status=await call('windows_status');assert.equal(status.r.isError,false);assert.equal(status.value.host,'FAKE-WINDOWS');
 const read=await call('windows_read',{path:'C:\\中文.txt'});assert.equal(read.value.text,'中文');
 const noAgent=await call('windows_status',{},null);assert.equal(noAgent.r.isError,true,'a call without an agent must fail closed');
 const before=remoteCalls;
 for(const [name,args]of [['windows_exec',{script:'whoami'}],['windows_py',{script:'print(1)'}],['windows_write',{path:'x',content:'x'}],['windows_replace',{path:'x',oldString:'x',newString:'y',expectedVersion:'v'}],['windows_upload',{localPath:'x',remotePath:'y'}],['windows_download',{localPath:'x',remotePath:'y'}],['windows_job',{action:'cancel',id:'x'}]]) {const denied=await call(name,args);assert.equal(denied.r.isError,true,name+' must fail closed without approval service');}
 assert.equal(remoteCalls,before);
 await fiber.dispose();assert.equal(ctx.tools.schemas().length,0);
 // Approval is remembered per class for one session: the first call asks, later ones do not.
 await ctx.plugin(Approval).await();
 fiber=ctx.plugin({name:'windows-fixture-approval',inject:['tools'],apply(context){plugin.install(context,{}, {buildOperation:(op,args)=>JSON.stringify({op,args}),transport:async()=>({stdout:JSON.stringify({ok:true}),stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false}),pyTransport:async()=>({stdout:'',stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false})});}});await fiber.await();
 const approval=ctx.get('approval');
 await call('windows_exec',{script:'whoami'});await call('windows_exec',{script:'hostname'});
 assert.deepEqual(approval.asked,['windows_exec'],'a second windows_exec must reuse the session grant');
 await call('windows_write',{path:'x',content:'x'});
 assert.deepEqual(approval.asked,['windows_exec','windows_write'],'mutations keep their own class');
 await call('windows_status');assert.equal(approval.asked.length,2,'read-only tools never ask');
 // windows_py runs arbitrary code, so it belongs to the exec class and must reuse that grant.
 const py=await call('windows_py',{script:'print(1)'});assert.equal(py.r.isError,false,'windows_py must run under the existing exec grant');assert.equal(py.value.stdout,'');
 assert.deepEqual(approval.asked,['windows_exec','windows_write'],'windows_py must not prompt again after exec was granted');
 console.log('Real ToolRuntime fixture passed: ten schemas, fake transport, session guard, approval fail-closed, one prompt per approval class, windows_py reusing the exec grant, disposal. No Windows connections.');
} finally {await ctx.fiber.dispose();}
