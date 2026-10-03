import { validFixtureReport } from './fixtures.mjs';

export const SOURCE='技术测试材料：先说明读者遇到的问题。\n再讲一个可以执行的办法。\n最后请读者记录一次尝试。';
export const BRIEF={topic:'技术测试选题：解释内容创作方法',audience:'技术测试受众：刚开始制作口播的人',claim:'先说明问题，再给操作步骤',goal:'记录一次内容创作尝试',platforms:['douyin','xiaohongshu'],duration_seconds:60,chars_per_minute:240,tone:'具体自然',uses_product:false,source_kinds:['method']};
export const CONTEXT={account_type:'personal',category:'general',scene:'ordinary',ai_use:'generated',rights:'owned',ai_confusable:'no',scope:'available_text_rules'};
export function fullFixture(options={}) {
 const calls=[];return {configured:true,model:'test-fixture',provider:'test-fixture',calls,async run({payload:p}){
  calls.push(p.node_id);if(options.failure?.(p))throw new Error('测试服务失败');let output;
  if(p.node_id==='A')output=validFixtureReport(p.paragraphs[0]);
  if(p.node_id==='R')output={evaluations:p.candidates.map(m=>({material_id:m.id,version:m.version,eligible:true,scores:{problem:4,audience:4,action:4,support:4,structure:4},reason:'测试匹配',differences:'测试差异',intended_use:'测试步骤',limitations:'非业务案例',evidence:[m.snippet.slice(0,20)]}))};
  if(p.node_id==='B')output={summary:'技术测试提纲',paragraphs:(p.edited_outline?.paragraphs||[{id:'P1',purpose:'解释方法',content_plan:'解释确认的步骤',reference_function:'先问题后步骤'}]).map(x=>({...x,material_refs:[{material_id:'direction',version:p.materials[0].version,quote:p.materials[0].content.split('\n')[0]}],required_product_keys:[],missing_fields:options.gap?['技术测试缺项']:[]})),conflicts:[]};
  if(p.node_id?.startsWith('C_'))output={title:options.loop&&!p.revision?'绝对成功的测试标题':'明确问题后解释步骤',cover_text:'技术流程测试',opening:'先说明问题',script:'这是技术测试口播：先说明问题，再讲操作步骤，最后记录一次尝试。',caption:p.platform==='xiaohongshu'?'技术测试配文':'',cta:'记录一次尝试',subtitles:['先问题','后步骤'],topics:['技术测试'],product_references:[]};
  if(p.node_id==='D'){
   const hasIssue=options.loop&&p.platform==='douyin'&&(options.repeat||p.fields.title.includes('绝对'));
   output={summary:'技术测试规则报告',checks:p.rules.map(r=>({rule_id:r.id,result:hasIssue&&r.id==='DY02'?'issue':'no_issue',explanation:'技术测试判断'})),issues:hasIssue&&p.rules.some(r=>r.id==='DY02')?[{rule_id:'DY02',field:'title',quote:p.fields.title,explanation:'测试标题问题',suggestion:'改为解释步骤',action:'revise',requires_direction_change:!!options.directionChange}]:[]};
  }
  return {output,model:'test-fixture',provider:'test-fixture',usage:{prompt_tokens:100,completion_tokens:100}};
 }};
}
