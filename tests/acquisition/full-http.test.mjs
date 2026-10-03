import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {createAcquisitionServer} from '../../services/acquisition/server.mjs';import {fullFixture,CONTEXT} from './full-fixtures.mjs';
test('完整 HTTP：素材和产品版本、分享链接、现稿规则检查、旧报告失效及版本导出',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'acq-http-')),app=createAcquisitionServer({dataDir:dir,runner:fullFixture()});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}/api/acquisition`;
 const req=async(p,data)=>{const r=await fetch(base+p,data?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}:{});return {status:r.status,value:await r.json()};};
 try{
 const m=await req('/materials',{data:{title:'HTTP 技术测试素材',kind:'method',content:'仅为 HTTP 技术测试',source:'测试夹具',rights:'owned'}});assert.equal(m.status,201);
 const update=await req('/materials/'+m.value.data.id,{expected_version:1,data:{title:'技术测试新版',kind:'method',content:'仅为技术测试的新版本',source:'测试夹具',rights:'owned'}});assert.equal(update.value.data.version,2);
 const conflict=await req('/materials/'+m.value.data.id,{expected_version:1,data:{title:'技术测试过期修改',kind:'method',content:'测试',source:'测试',rights:'owned'}});assert.equal(conflict.status,409);
 const p=await req('/products',{data:{name:'技术测试产品（非真实保险）',version_label:'测试v1',source:'测试夹具',conditions:'仅为参数存储验证，不作产品介绍',parameters:[{key:'example_value',label:'测试值',value:'1',unit:'',nature:'other',source:'测试夹具'}]}});assert.equal(p.status,201);
 assert.equal((await req('/links',{share_text:'https://xhslink.cn/o/a https://v.douyin.com/a'})).value.data.length,2);
 let t=(await req('/tasks',{entry:'direct_review',platform:'douyin',fields:{script:'HTTP 技术测试口播'}})).value.data;
 const command=async(action,data={})=>{const r=await req('/tasks/'+t.id+'/command',{action,command_id:randomUUID(),expected_revision:t.revision,...data});assert.equal(r.status,200);t=r.value.data;};
 await command('start_review',{publication:{douyin:{...CONTEXT,ai_use:'none'}},max_revisions:0});assert.equal(t.reviews.length,1);const d=t.drafts[0];
 const md=await fetch(base+`/tasks/${t.id}/drafts/${d.id}/export?format=md`);assert.equal(md.status,200);assert.match(await md.text(),/平台审核通过/);
 await command('set_publication',{publication:{douyin:{...CONTEXT,ai_use:'none',scene:'commercial'}}});assert.equal(t.reviews[0].current,false);
 const artifact=(await req(`/tasks/${t.id}/artifacts/${t.artifacts[0].id}`));assert.equal(artifact.status,200);
 const rules=await req('/rules');assert.ok(rules.value.data.rules.every(r=>r.source_url.startsWith('https://')));
 }finally{await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});}
});
