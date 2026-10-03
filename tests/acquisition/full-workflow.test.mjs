import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFullWorkflow } from '../../services/acquisition/full-workflow.mjs';
import { validRecommendations,validDraft,fingerprint } from '../../services/acquisition/full-contracts.mjs';
import { createLingzaoExtractor,shareLinks } from '../../services/acquisition/extraction.mjs';
import { validFixtureReport } from './fixtures.mjs';

import { SOURCE, BRIEF, CONTEXT, fullFixture } from './full-fixtures.mjs';

function setup(runner=fullFixture(),extra={}){
 const dir=mkdtempSync(join(tmpdir(),'acquisition-full-'));const args={databasePath:join(dir,'tasks.sqlite'),checkpointPath:join(dir,'checkpoints.sqlite'),runner,...extra};let app=createFullWorkflow(args);
 return {runner,args,get app(){return app;},restart(){app.close();app=createFullWorkflow(args);},close(){app.close();rmSync(dir,{recursive:true,force:true});}};
}
async function cmd(s,t,action,data={}){return s.app.command(t.id,{action,command_id:randomUUID(),expected_revision:t.revision,...data});}
async function sourceToBrief(s){let t=await s.app.create({title:'技术测试完整流程',text:SOURCE});assert.equal(s.runner.calls.length,0);t=await cmd(s,t,'confirm',{mode:'full'});assert.equal(t.workflow.next,'confirm_brief');return t;}
async function readyDrafts(s){let t=await sourceToBrief(s);t=await cmd(s,t,'confirm_brief',{brief:BRIEF});t=await cmd(s,t,'select_mode',{mode:'method'});t=await cmd(s,t,'confirm_outline',{outline_hash:fingerprint(t.workflow.outline)});return t;}
const reviewData={publication:{douyin:CONTEXT,xiaohongshu:CONTEXT},max_revisions:2};

test('完整 Graph：三个原生确认点、空库零推荐调用、重启恢复、六岗位写作检查及导出',async()=>{
 const s=setup();try{let t=await sourceToBrief(s);s.restart();t=s.app.store.get(t.id);t=await cmd(s,t,'confirm_brief',{brief:BRIEF});assert.equal(t.workflow.next,'choose_material');assert.equal(t.workflow.recommendations.items.length,0);assert.deepEqual(s.runner.calls,['A']);
 s.restart();t=s.app.store.get(t.id);t=await cmd(s,t,'select_mode',{mode:'method'});assert.equal(t.workflow.next,'confirm_outline');assert.equal(t.drafts.length,0);s.restart();t=s.app.store.get(t.id);t=await cmd(s,t,'confirm_outline',{outline_hash:fingerprint(t.workflow.outline)});assert.equal(t.workflow.next,'review_options');assert.equal(t.drafts.length,2);
 t=await cmd(s,t,'start_review',reviewData);assert.equal(t.workflow.next,'choose_version');assert.equal(t.reviews.length,2);assert.ok(t.reviews.every(r=>r.current));assert.deepEqual(s.runner.calls,['A','B','C_DY','C_XHS','D','D']);
 t=await cmd(s,t,'adopt',{draft_ids:t.workflow.current_drafts});const out=s.app.export(t.id,t.workflow.adopted.douyin);assert.equal(out.version,1);assert.equal(out.reviews[0].payload.coverage.platform_coverage,'incomplete');assert.equal(out.reviews[0].payload.coverage.requested_scope_complete,true);
 }finally{s.close();}
});
test('推荐排序真实库版本与引用；少于五个不补，库与销售数据隔离',async()=>{
 const s=setup();try{for(let i=0;i<3;i++)s.app.store.putMaterial({title:'技术测试方法'+i,kind:'method',content:'技术测试方法材料'+i+'：先说明问题，再列步骤。',source:'测试夹具，不是用户案例',rights:'owned',tags:['创作']});let t=await sourceToBrief(s);t=await cmd(s,t,'confirm_brief',{brief:BRIEF});assert.equal(t.workflow.recommendations.items.length,3);assert.equal(s.runner.calls.at(-1),'R');const m=t.workflow.recommendations.items[0];t=await cmd(s,t,'select_material',{material_id:m.id,material_version:m.version});assert.equal(t.workflow.selection.material.id,m.id);assert.equal(t.workflow.selection.material.version,1);
 }finally{s.close();}
 const m={id:'known',version:1,snippet:'真实候选'};assert.throws(()=>validRecommendations({evaluations:[]},[m]),/没有获得评价/);
});
test('缺产品不能策划；缺材料不能写稿；编辑提纲需重新检查，修改方向保留历史版本',async()=>{
 const s=setup(fullFixture({gap:true}));try{let t=await sourceToBrief(s);t=await cmd(s,t,'confirm_brief',{brief:{...BRIEF,uses_product:true}});await assert.rejects(cmd(s,t,'select_mode',{mode:'product'}),/确认产品资料/);assert.deepEqual(s.runner.calls,['A']);t=await cmd(s,t,'back',{to:'brief'});t=await cmd(s,t,'confirm_brief',{brief:BRIEF});t=await cmd(s,t,'select_mode',{mode:'method'});await assert.rejects(cmd(s,t,'confirm_outline',{outline_hash:fingerprint(t.workflow.outline)}),/缺失材料/);assert.equal(t.drafts.length,0);
 }finally{s.close();}
 const x=setup();try{let t=await readyDrafts(x);const ids=t.drafts.map(d=>d.id);t=await cmd(x,t,'back',{to:'brief'});assert.equal(t.drafts.length,2);assert.deepEqual(t.drafts.map(d=>d.id),ids);assert.deepEqual(t.workflow.current_drafts,{});
 }finally{x.close();}
});
test('一平台失败只重试失败节点；成功产物不重新付费',async()=>{
 let fail=true;const s=setup(fullFixture({failure:p=>p.node_id==='C_XHS'&&fail}));try{let t=await readyDrafts(s);assert.equal(t.workflow.next,'wait_retry');assert.equal(t.drafts.length,1);assert.equal(t.drafts[0].platform,'douyin');fail=false;t=await cmd(s,t,'retry');assert.equal(t.drafts.length,2);assert.equal(s.runner.calls.filter(x=>x==='C_DY').length,1);assert.equal(s.runner.calls.filter(x=>x==='C_XHS').length,2);
 }finally{s.close();}
});
test('有界 Loop：可修改问题触发本平台修订，范围未完成和方向变化不触发；编辑后旧报告过期',async()=>{
 const s=setup(fullFixture({loop:true}));try{let t=await readyDrafts(s);t=await cmd(s,t,'start_review',reviewData);assert.equal(t.workflow.batches.douyin.revisions,1);assert.equal(t.workflow.batches.xiaohongshu.revisions,0);assert.equal(t.drafts.length,3);const d=s.app.store.draft(t.workflow.current_drafts.douyin);t=await cmd(s,t,'edit_draft',{platform:'douyin',draft_id:d.id,fields:{...d.fields,title:'手工修改测试标题'}});assert.ok(t.reviews.filter(r=>r.platform==='douyin').every(r=>!r.current));assert.equal(t.drafts.length,4);
 }finally{s.close();}
 for(const opts of [{loop:true,directionChange:true},{loop:true}]){const s=setup(fullFixture(opts));try{let t=await readyDrafts(s);t=await cmd(s,t,'start_review',{...reviewData,publication:opts.directionChange?reviewData.publication:{douyin:{...CONTEXT,scope:'platform_rules'},xiaohongshu:{...CONTEXT,scope:'platform_rules'}}});assert.equal(t.drafts.length,2);assert.equal(t.workflow.batches.douyin.revisions,0);}finally{s.close();}}
});
test('循环达到次数上限；模型伪造引用拒绝；预算超限在调用前暂停',async()=>{
 const s=setup(fullFixture({loop:true,repeat:true}));try{let t=await readyDrafts(s);t=await cmd(s,t,'start_review',{...reviewData,max_revisions:1});assert.equal(t.workflow.batches.douyin.revisions,1);assert.match(t.workflow.stop_reasons.douyin,/上限/);}finally{s.close();}
 const b=setup();try{let t=await b.app.create({text:SOURCE,budget:{max_calls:1,max_estimated_usd:1}});t=await cmd(b,t,'confirm',{mode:'full'});t=await cmd(b,t,'confirm_brief',{brief:BRIEF});t=await cmd(b,t,'select_mode',{mode:'method'});assert.equal(t.error.code,'BUDGET_REACHED');assert.equal(b.runner.calls.length,1);}finally{b.close();}
 assert.throws(()=>validDraft({title:'测试',cover_text:'测试',opening:'测试',script:'我的客户每年领取32万元',caption:'',cta:'测试',subtitles:[],topics:[],product_references:[]},'douyin',{mode:'method',materials:[]}),/自有客户经历/);
});
test('现稿入口跳过 A/R/B；提取只接受完成正文，失败可补全文并重新确认',async()=>{
 const s=setup();try{let t=await s.app.create({entry:'direct_review',platform:'douyin',fields:{script:'技术测试现有口播稿'}});assert.equal(s.runner.calls.length,0);t=await cmd(s,t,'start_review',{publication:{douyin:{...CONTEXT,ai_use:'none'}},max_revisions:0});assert.deepEqual(s.runner.calls,['D']);t=await s.app.create({input_kind:'link',share_text:'分享 https://xhslink.cn/o/40Alw2rHXSo'});assert.equal(t.error.code,'EXTRACTION_NOT_CONFIGURED');t=await cmd(s,t,'supply_text',{text:SOURCE});assert.equal(t.workflow.next,'confirm_source');assert.equal(s.runner.calls.length,1);
 }finally{s.close();}
 assert.equal(shareLinks('https://xhslink.cn/o/a https://v.douyin.com/a').length,2);assert.throws(()=>shareLinks('https://evil.example/a'),/只接受/);
 const extractor=createLingzaoExtractor({apiKey:'test-not-real',baseUrl:'https://test.example',fetchImpl:async()=>new Response(JSON.stringify({data:{items:[{status:'partial',content:'只有标题'}]}}),{status:200})});await assert.rejects(extractor.extract('https://xhslink.cn/o/a'),/核心文案/);
});
test('重复命令不会重复调用；旧版本和稿件跨任务导出被拒绝',async()=>{
 const s=setup();try{let t=await s.app.create({text:SOURCE});const body={action:'confirm',mode:'full',command_id:randomUUID(),expected_revision:t.revision};t=await s.app.command(t.id,body);await s.app.command(t.id,body);assert.equal(s.runner.calls.length,1);await assert.rejects(cmd(s,{...t,revision:1},'confirm_brief',{brief:BRIEF}),/任务已更新/);const other=await s.app.create({entry:'direct_review',platform:'douyin',fields:{script:'技术测试其他任务稿件'}});assert.throws(()=>s.app.export(t.id,other.drafts[0].id),/不属于/);
 }finally{s.close();}
});

test('分批审核失败恢复只补失败批次；所有已加载规则均覆盖，前批次不重复调用',async()=>{
 let fail=true;const s=setup(fullFixture({failure:p=>p.node_id==='D'&&p.platform==='xiaohongshu'&&p.rules[0].id==='XHSP02'&&fail}));
 try{let t=await readyDrafts(s);t=await cmd(s,t,'start_review',{...reviewData,publication:{douyin:CONTEXT,xiaohongshu:{...CONTEXT,scene:'commercial'}}});assert.equal(t.workflow.next,'wait_retry');assert.equal(s.runner.calls.filter(x=>x==='D').length,3);fail=false;s.restart();t=s.app.store.get(t.id);t=await cmd(s,t,'retry');assert.equal(s.runner.calls.filter(x=>x==='D').length,4);const r=t.reviews.find(r=>r.platform==='xiaohongshu');assert.equal(r.payload.checks.length,9);assert.equal(new Set(r.payload.checks.map(c=>c.rule_id)).size,9);assert.equal(r.current,true);
 }finally{s.close();}
});
test('用户停止批次：当前调用结果保存，不发起下一平台或修订请求',async()=>{
 const runner=fullFixture();const original=runner.run.bind(runner);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 runner.run=async args=>{if(args.payload.node_id==='D'){entered();await gate;}return original(args);};
 const s=setup(runner);try{let t=await readyDrafts(s);const checking=cmd(s,t,'start_review',reviewData);await started;t=s.app.store.get(t.id);await cmd(s,t,'stop_batch');release();t=await checking;assert.equal(t.workflow.next,'choose_version');assert.equal(t.reviews.length,1);assert.equal(runner.calls.filter(c=>c==='D').length,1);assert.equal(t.workflow.stop_reasons.douyin,'用户停止本批次');}finally{s.close();}
});

test('A 模型协议固定八个对象键，程序映射成八维报告；缺键不能保存',async()=>{
 const {validateAnalysisOutput}=await import('../../services/acquisition/nodes.mjs');const {validFixtureReport}=await import('./fixtures.mjs');
 const p={id:'P001',text:SOURCE.split('\n')[0]},r=validFixtureReport(p);const wire={...r,dimensions:Object.fromEntries(r.dimensions.map(({id,...value})=>[id,value]))};
 const out=validateAnalysisOutput(wire,[p]);assert.equal(out.dimensions.length,8);assert.equal(out.dimensions[0].name,'选题与受众');delete wire.dimensions.structure;assert.throws(()=>validateAnalysisOutput(wire,[p]),/八个指定维度/);
});
test('建议条款允许 no_issue 与 advice 并存；要求条款的矛盾报告仍拒绝',async()=>{
 const {validReview}=await import('../../services/acquisition/full-contracts.mjs');const rule={id:'S',kind:'suggestion',source_url:'https://official.example/rule',clause:'建议条款'};
 const report={summary:'建议不等于违规',checks:[{rule_id:'S',result:'no_issue',explanation:'不据此判违规'}],issues:[{rule_id:'S',field:'script',quote:'测试原句',explanation:'建议',suggestion:'保留真实说明',action:'advice',requires_direction_change:false}]};
 assert.equal(validReview(report,[rule],{script:'测试原句'}).issues[0].action,'advice');assert.throws(()=>validReview(report,[{...rule,kind:'requirement'}],{script:'测试原句'}),/状态冲突/);
});
