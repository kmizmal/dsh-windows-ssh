import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire,registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.env.DSH_HOST_MODULE_ROOT??'/root/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/node_modules';
const hostURL=pathToFileURL(path.join(root,'host-test.mjs')).href;
const requireHost=createRequire(hostURL);
const load=name=>import(pathToFileURL(requireHost.resolve(name)).href);
registerHooks({resolve(specifier,context,next){return next(specifier,specifier.startsWith('@deepseek-ai/')?{...context,parentURL:hostURL}:context);}});
const [{Context,Service},{ToolRuntime,assertSupportedJsonSchema},boot,plugin]=await Promise.all([load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-tools'),load('@deepseek-ai/dsh-app-boot'),import('../index.js')]);
class Prompt extends Service {constructor(ctx){super(ctx,'systemPrompt');}tools(){return ()=>{};}section(){return ()=>{};}assemble(){return {sections:[],contexts:[],tools:[],variables:{}};}}
const ctx=new Context();let calls=0;let remoteCalls=0;
const agent={session:{id:'fixture-session',header:{cwd:'/tmp'}},get ctx(){return ctx;}};
const call=async(name,args={},actor=agent)=>{const r=await ctx.tools.execute({name,arguments:args,agent:actor,callId:'fixture-'+(++calls),signal:new AbortController().signal});return {r,value:r.isError?undefined:JSON.parse(r.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'))};};
let fiber;
try {
 await ctx.plugin(Prompt).await();await ctx.plugin(ToolRuntime).await();
 const manifest=boot.readProfileManifest('compat',path.resolve(import.meta.dirname,'..'));
 assert.equal(manifest.name,'dsh-windows-ssh');assert.equal(boot.evaluatePluginCompatibility(manifest),undefined);
 const entries=boot.composeEntries([boot.bundlePatchPaths(path.resolve(import.meta.dirname,'..'),manifest.dsh.bundle).flatMap(file=>boot.loadOverlayPatches('compat',file))]);assert.equal(entries[0].name,'dsh-windows-ssh');
 fiber=ctx.plugin({name:'windows-fixture',inject:['tools'],apply(context){plugin.install(context,{}, {buildOperation:(op,args)=>JSON.stringify({op,args}),transport:async()=>{remoteCalls++;return {stdout:JSON.stringify({ok:true,host:'FAKE-WINDOWS',text:'中文',version:'v1'}),stderr:'',exitCode:0,timedOut:false,aborted:false,truncated:false,remoteStateUnknown:false};}});}});await fiber.await();
 assert.equal(ctx.tools.schemas().length,9);for(const s of ctx.tools.schemas())assertSupportedJsonSchema(s.parameters);
 const status=await call('windows_status');assert.equal(status.r.isError,false);assert.equal(status.value.host,'FAKE-WINDOWS');
 const read=await call('windows_read',{path:'C:\\中文.txt'});assert.equal(read.value.text,'中文');
 const missing=await call('windows_status',{},undefined); // default parameter supplies agent; explicit no-agent below
 const noAgent=await ctx.tools.execute({name:'windows_status',arguments:{},callId:'no-agent',signal:new AbortController().signal});assert.equal(noAgent.isError,true);
 const before=remoteCalls;
 for(const [name,args]of [['windows_exec',{script:'whoami'}],['windows_write',{path:'x',content:'x'}],['windows_replace',{path:'x',oldString:'x',newString:'y',expectedVersion:'v'}],['windows_upload',{localPath:'x',remotePath:'y'}],['windows_download',{localPath:'x',remotePath:'y'}],['windows_job',{action:'cancel',id:'x'}]]) {const denied=await call(name,args);assert.equal(denied.r.isError,true,name+' must fail closed without approval service');}
 assert.equal(remoteCalls,before);
 await fiber.dispose();assert.equal(ctx.tools.schemas().length,0);
 console.log('Real ToolRuntime fixture passed: nine schemas, fake transport, session guard, approval fail-closed, disposal. No Windows connections.');
} finally {await ctx.fiber.dispose();}
