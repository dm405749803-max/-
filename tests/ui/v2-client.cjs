const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const calls=[];
const fetchImpl=async (url,options={})=>{calls.push({url,options});if(url.endsWith('/api/v2/customers/c1'))return {ok:true,status:200,json:async()=>({data:{customer_id:'c1',revision:2},trace_id:'trace-detail'})};if(url.includes('/api/v2/opportunities/o1/drafts'))return {ok:true,status:200,json:async()=>({data:{draft_id:'d1',draft:'草稿'},trace_id:'trace-draft'})};if(url.endsWith('/api/v2/tasks/t1'))return {ok:false,status:409,json:async()=>({error:{code:'REVISION_CONFLICT',message:'版本冲突',details:{expected:1}},trace_id:'trace-conflict'})};return {ok:true,status:200,json:async()=>({data:[],trace_id:'trace-list'})};};
const context=vm.createContext({fetch:fetchImpl,URLSearchParams,globalThis:null});context.globalThis=context;
vm.runInContext(fs.readFileSync(path.join(__dirname,'../../dist/v2-api.js'),'utf8'),context);

(async()=>{
 const Client=context.SalesWorkbenchV2Client,client=new Client({fetchImpl});
 const detail=await client.getCustomer('c1');assert.equal(detail.data.revision,2);assert.equal(detail.trace_id,'trace-detail');
 await client.createDraft('o1',{latest_message_id:'m9',expected_revision:4});
 assert.equal(calls[1].url,'/api/v2/opportunities/o1/drafts');
 assert.deepEqual(JSON.parse(calls[1].options.body),{latest_message_id:'m9',expected_revision:4});
 await client.patchOpportunity('o1',{expected_revision:7,changes:{budget_amount:0,budget_currency:'CNY'}});
 assert.equal(calls[2].url,'/api/v2/opportunities/o1');
 assert.deepEqual(JSON.parse(calls[2].options.body),{expected_revision:7,changes:{budget_amount:0,budget_currency:'CNY'}});
 await client.listCustomers({joined_from:'2026-09-01',joined_to:'2026-09-30'});assert.match(calls[3].url,/joined_from=2026-09-01/);
 await client.listMemoryProposals({status:'pending'});assert.equal(calls[4].url,'/api/v2/memory-review/proposals?status=pending');
 await client.listAllRecommendations({status:'pending'});assert.equal(calls[5].url,'/api/v2/product-match/recommendations?status=pending');
 await client.transcribeMedia('o1',{filename:'客户语音.m4a',mime_type:'audio/mp4',data_base64:'dm9pY2U=',duration_seconds:8});
 assert.equal(calls[6].url,'/api/v2/opportunities/o1/media-transcriptions');
 assert.deepEqual(JSON.parse(calls[6].options.body),{filename:'客户语音.m4a',mime_type:'audio/mp4',data_base64:'dm9pY2U=',duration_seconds:8});
 await assert.rejects(()=>client.patchTask('t1',{expected_revision:1,changes:{status:'completed'}}),error=>error.code==='REVISION_CONFLICT'&&error.status===409&&error.traceId==='trace-conflict');
 console.log('PASS — independent v2 client routes, request bodies, envelope parsing, and 409 errors.');
})().catch(error=>{console.error(error);process.exitCode=1;});
