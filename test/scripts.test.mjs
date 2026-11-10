import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { buildOperation } from '../lib/scripts.mjs';
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;
function run(operation, args) {
  const bootstrap = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))';
  const p = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], { input: buildOperation(operation, args), encoding: 'utf8', maxBuffer: 8*1024*1024 });
  assert.equal(p.status, 0, p.stderr + p.stdout);
  return JSON.parse(p.stdout.trim());
}
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'files-'));
  try { fn(join(dir, '中文 $x [a].txt'), dir); } finally { rmSync(dir, { recursive:true, force:true }); }
}
test('builder injects only base64 JSON data', () => {
  const args = { path: "C:\\中文\\'; Write-Error PWNED; #", content: '$(Get-Secret)\n"quoted"' };
  const script = buildOperation('write', args);
  assert.ok(!script.includes(args.path)); assert.ok(!script.includes(args.content));
  const encoded = script.match(/\$requestBase64 = '([A-Za-z0-9+/=]+)'/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded,'base64').toString('utf8')), {operation:'write',args});
});
test('builder rejects unsupported operations and non-JSON arguments', () => {
  assert.throws(() => buildOperation('evil',{}), /Unsupported operation/);
  assert.throws(() => buildOperation('read',null), /object/);
  assert.throws(() => buildOperation('read',{ x:undefined }), /JSON/);
});
test('huge line pages resume within UTF8 budget', {skip:!pwsh}, () => fixture(path => {
  const content = '头😀'.repeat(100) + '\nsecond\nthird'; writeFileSync(path,content);
  let offset=1,column=0,text='',pages=0;
  do {
    const r=run('readlines',{path,offset,column,limit:2,maxBytes:97});
    assert.equal(r.ok,true,JSON.stringify(r));
    assert.ok(Buffer.byteLength(r.lines.map(x=>x.text).join(''))<=97);
    text+=r.lines.map(x=>x.text+(x.truncated?'':x.newline)).join('');
    offset=r.nextOffset;column=r.nextColumn;pages++;
    if(!r.hasMore)break;
  }while(pages<100);
  assert.equal(text,content);assert.ok(pages>5);
}));
test('strict UTF8, small-read cap and UTF16 BOM preservation', {skip:!pwsh}, () => fixture(path => {
  writeFileSync(path,Buffer.from([255,254,97,0,13,0,10,0,98,0]));
  const r=run('read',{path,encoding:'utf16le'});assert.equal(r.content,'a\r\nb');assert.equal(r.bom,true);
  assert.equal(run('replace',{path,oldString:'a\r\nb',newString:'c\r\nd',expectedVersion:r.version}).ok,true);
  assert.deepEqual(readFileSync(path),Buffer.from([255,254,99,0,13,0,10,0,100,0]));
  writeFileSync(path,Buffer.from([195,40]));assert.equal(run('read',{path}).ok,false);
  writeFileSync(path,'large');assert.equal(run('read',{path,maxBytes:2}).error.code,'FILE_TOO_LARGE');
}));
test('streaming replace crosses chunks and refuses unsafe counts and stale versions', {skip:!pwsh}, () => fixture((path,dir) => {
  const original='x'.repeat(4095)+'needle\nend'+'z'.repeat(5000);writeFileSync(path,original);
  const version=run('readlines',{path,limit:1,maxBytes:8}).version;
  const r=run('replace',{path,oldString:'needle\nend',newString:'changed',expectedVersion:version});
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.count,1);
  assert.equal(readFileSync(path,'utf8'),original.replace('needle\nend','changed'));
  assert.equal(run('replace',{path,oldString:'x',newString:'',expectedVersion:version}).error.code,'VERSION_CONFLICT');
  writeFileSync(path,'aba aba');const v=run('stat',{path}).version;
  for(const extra of [{},{all:true,expectedCount:3}]){
    assert.equal(run('replace',{path,oldString:'aba',newString:'new',expectedVersion:v,...extra}).ok,false);
    assert.equal(readFileSync(path,'utf8'),'aba aba');
  }
  assert.equal(run('replace',{path,oldString:'none',newString:'',expectedVersion:v}).ok,false);
  assert.equal(run('replace',{path,oldString:'aba',newString:'new',expectedVersion:v,all:true,expectedCount:2}).count,2);
  assert.deepEqual(readdirSync(dir),[basename(path)]);
}));
test('write protects existing destination and transfers verify SHA256', {skip:!pwsh}, () => fixture(path => {
  assert.equal(run('write',{path,content:'中文'}).ok,true);
  assert.equal(run('write',{path,content:'bad'}).error.code,'ALREADY_EXISTS');
  const bytes=Buffer.from([0,255,1,128]);const up=run('upload',{path,dataBase64:bytes.toString('base64'),overwrite:true});
  assert.equal(up.ok,true,JSON.stringify(up));
  // The download record describes the file; the bytes travel separately (transport attachment).
  const down=run('download',{path});
  assert.equal(down.sha256,up.sha256);assert.equal(down.dataBase64,undefined,'the record must not carry content');
  assert.equal(down.bytes,bytes.length);
}));
test('line ranges, UTF16BE, missing version and failed upload cleanup', {skip:!pwsh}, () => fixture((path,dir) => {
  writeFileSync(path, 'one\r\ntwo\nthree\rfour');
  let r = run('readlines', {path,offset:2,limit:1});
  assert.deepEqual(r.lines.map(x=>x.text), ['two']); assert.equal(r.nextOffset,3); assert.equal(r.hasMore,true);
  r = run('readlines', {path,offset:100,limit:1}); assert.deepEqual(r.lines,[]); assert.equal(r.hasMore,false);
  assert.equal(run('replace',{path,oldString:'one',newString:'x'}).error.code,'INVALID_ARGUMENT');
  const before = readFileSync(path);
  assert.equal(run('upload',{path,dataBase64:'YWJj',sha256:'0'.repeat(64),overwrite:true}).error.code,'HASH_MISMATCH');
  assert.deepEqual(readFileSync(path),before);assert.deepEqual(readdirSync(dir),[basename(path)]);
  const be=Buffer.from([254,255,0,97,0,13,0,10,0,98]);writeFileSync(path,be);
  r=run('read',{path,encoding:'utf16be'});assert.equal(r.content,'a\r\nb');
  assert.equal(run('read',{path,encoding:'utf8'}).error.code,'ENCODING');
  assert.equal(run('replace',{path,oldString:'a',newString:'z',expectedVersion:r.version,encoding:'utf16be'}).ok,true);
  assert.deepEqual(readFileSync(path),Buffer.from([254,255,0,122,0,13,0,10,0,98]));
}));
test('bounded page reads a multi-megabyte line without returning the tail', {skip:!pwsh}, () => fixture(path => {
  writeFileSync(path,'x'.repeat(8*1024*1024)+'\nend');
  const r=run('readlines',{path,limit:1,maxBytes:128});
  assert.equal(r.lines[0].text.length,128);assert.equal(r.nextOffset,1);assert.equal(r.nextColumn,128);
  assert.equal(r.truncated,true);assert.equal(r.hasMore,true);assert.equal(r.versionKind,'metadata-v1');
}));
