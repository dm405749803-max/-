'use strict';

const mediaTranscriptionRuntime={byOpportunity:{},busy:''};

function mediaEntry(opportunity){return opportunity?mediaTranscriptionRuntime.byOpportunity[opportunity.opportunity_id]||null:null;}
function formatMediaBytes(bytes){if(!Number.isFinite(bytes))return '';if(bytes<1024*1024)return `${Math.max(1,Math.round(bytes/1024))} KB`;return `${(bytes/1024/1024).toFixed(1)} MB`;}
function formatMediaDuration(seconds){if(!Number.isFinite(seconds))return '时长待识别';const minute=Math.floor(seconds/60),second=Math.round(seconds%60);return `${minute}:${String(second).padStart(2,'0')}`;}
function mediaKind(file){return file.type.startsWith('video/')?'video':'audio';}

function readMediaDuration(url,kind){
 return new Promise(resolve=>{
  const element=document.createElement(kind==='video'?'video':'audio');let settled=false;
  const done=value=>{if(settled)return;settled=true;resolve(Number.isFinite(value)?value:null);};
  element.preload='metadata';element.onloadedmetadata=()=>done(Number(element.duration));element.onerror=()=>done(null);element.src=url;
  setTimeout(()=>done(null),8000);
 });
}

async function requestMediaTranscription(opportunity,item){
 if(!opportunity||!item||item.status==='transcribing')return;
 if(v2Runtime.status!=='connected'){item.status='unavailable';item.error='请在本机一体化工作台中使用语音转写。';render();return;}
 if(!connection.asrConfigured){item.status='unavailable';item.error='还未配置百炼语音识别密钥，当前只能试听，不能进入AI分析。';render();return;}
 mediaTranscriptionRuntime.busy=opportunity.opportunity_id;item.status='transcribing';item.error='';render();
 try{
  const data_base64=await fileToBase64(item.file),response=await v2Runtime.client.transcribeMedia(opportunity.opportunity_id,{filename:item.file.name,mime_type:item.file.type,data_base64,duration_seconds:item.duration});
  item.transcript=response.data.transcript||'';item.reviewHints=response.data.review_hints||[];item.status='transcribed';toast('AI 已完成识别，请听完原内容后选择是否采用。');
 }catch(error){item.status='error';item.error=error.message||'识别失败';toast(item.error);}
 finally{mediaTranscriptionRuntime.busy='';render();}
}

function mediaTranscriptionHTML(opportunity){
 if(!opportunity)return '';
 const item=mediaEntry(opportunity),configured=Boolean(connection.asrConfigured),busy=mediaTranscriptionRuntime.busy===opportunity.opportunity_id;
 if(!item)return `<section class="panel media-transcription"><div class="panel-head"><div><h2>语音与短视频</h2><small>销售听完或看完后，只需确认识别结果是否可用</small></div>${configured?tag('AI转写已接通','green'):tag('AI转写待配置','orange')}</div><div class="panel-body"><label class="media-picker"><input id="customer-media-file" type="file" accept="audio/*,video/mp4,video/quicktime,video/webm,video/x-matroska"><strong>选择语音或短视频</strong><span>当前演练版：不超过 5 分钟、7 MB</span></label><p class="media-limit">选取后自动识别。原文件只在本页试听；只有销售确认可用的识别结果才会进入后续分析。</p></div></section>`;
 const preview=item.kind==='video'?`<video controls preload="metadata" src="${escapeHTML(item.url)}"></video>`:`<audio controls preload="metadata" src="${escapeHTML(item.url)}"></audio>`;
 const status=item.status==='transcribed'?tag('等待销售确认','orange'):item.status==='transcribing'?tag('AI识别中','blue'):item.status==='error'?tag('识别失败','red'):tag('暂不可用','orange');
 const transcript=item.status==='transcribed'?`<details class="media-transcript-details"><summary>查看AI识别文字（非必做）</summary><p>${escapeHTML(item.transcript||'')}</p></details>`:'';
 const message=item.error?`<div class="notice warning">${escapeHTML(item.error)}</div>`:item.status==='transcribing'?'<div class="notice">正在识别，完成后请销售听完或看完原内容，再决定是否采用。</div>':'';
 const decisions=item.status==='transcribed'?`<div class="decision-actions">${button('识别有误，不采用','reject-media-transcript','',busy?'disabled':'')}${button('确认可用，进入分析','approve-media-transcript','primary',busy?'disabled':'')}</div>`:`<div class="decision-actions">${item.status==='error'?button('重新识别','retry-media-transcription','',busy?'disabled':''):''}${button('不采用并移除','reject-media-transcript','',busy?'disabled':'')}</div>`;
 return `<section class="panel media-transcription"><div class="panel-head"><div><h2>语音与短视频</h2><small>${escapeHTML(item.file.name)} · ${formatMediaBytes(item.file.size)} · ${formatMediaDuration(item.duration)}</small></div>${status}</div><div class="panel-body"><div class="media-preview"><div>${preview}</div><div><h3>${item.kind==='video'?'请先看完视频':'请先听完语音'}</h3><p>不要求逐字修改。听完或看完后，只判断AI识别内容能否用于后续分析。</p>${button('更换文件','replace-customer-media','small')}</div></div>${message}${transcript}${decisions}</div></section>`;
}

const baseMediaRenderCustomers=renderCustomers;
renderCustomers=function(){
 const opportunity=activeOpportunity(current()),html=baseMediaRenderCustomers();
 const marker='<section class="panel review-decision"><div class="panel-head"><div><h2>本轮信息整理</h2>';
 return html.replace(marker,`${mediaTranscriptionHTML(opportunity)}${marker}`);
};

document.addEventListener('change',async event=>{
 if(event.target?.id!=='customer-media-file')return;
 const opportunity=activeOpportunity(current()),file=event.target.files?.[0];if(!opportunity||!file)return;
 const kind=mediaKind(file),supported=file.type.startsWith('audio/')||['video/mp4','video/quicktime','video/webm','video/x-matroska'].includes(file.type);
 if(!supported){event.target.value='';return toast('请选择常见语音文件，或 MP4、MOV、WebM、MKV 短视频。');}
 if(file.size>7_000_000){event.target.value='';return toast('文件超过 7 MB，请先压缩或截取需要识别的片段。');}
 const old=mediaEntry(opportunity);if(old?.url)URL.revokeObjectURL(old.url);
 const url=URL.createObjectURL(file),duration=await readMediaDuration(url,kind);
 if(Number.isFinite(duration)&&duration>300){URL.revokeObjectURL(url);event.target.value='';return toast('当前一次最多处理 5 分钟，请先截取与本次沟通有关的片段。');}
 const item={file,url,kind,duration,status:'selected',transcript:'',reviewHints:[],error:''};mediaTranscriptionRuntime.byOpportunity[opportunity.opportunity_id]=item;render();await requestMediaTranscription(opportunity,item);
});

document.addEventListener('click',async event=>{
 const el=event.target.closest?.('[data-action]');if(!el)return;
 const opportunity=activeOpportunity(current());if(!opportunity)return;const item=mediaEntry(opportunity),action=el.dataset.action;
 if(action==='replace-customer-media'){
  if(item?.url)URL.revokeObjectURL(item.url);delete mediaTranscriptionRuntime.byOpportunity[opportunity.opportunity_id];render();setTimeout(()=>$('#customer-media-file')?.click(),0);return;
 }
 if(action==='retry-media-transcription'){if(item)await requestMediaTranscription(opportunity,item);return;}
 if(action==='reject-media-transcript'){
  if(!item)return;if(item.url)URL.revokeObjectURL(item.url);delete mediaTranscriptionRuntime.byOpportunity[opportunity.opportunity_id];render();toast('错误识别结果已丢弃，没有写入客户会话或后续分析。');return;
 }
 if(action==='approve-media-transcript'){
  if(!item?.transcript?.trim()||item.status!=='transcribed')return toast('当前没有可确认的AI识别结果。');const transcript=item.transcript.trim();
  if(v2Runtime.status!=='connected')return toast('请在本机一体化工作台中确认媒体文字。');
  mediaTranscriptionRuntime.busy=opportunity.opportunity_id;render();
  try{
   await v2Runtime.client.addMessage(opportunity.opportunity_id,{idempotency_key:uiId('media-message'),role:'customer',text:transcript,status:'received',source:'media_transcription',environment:opportunity.environment||'simulation',occurred_at:new Date().toISOString()});
   if(item.url)URL.revokeObjectURL(item.url);delete mediaTranscriptionRuntime.byOpportunity[opportunity.opportunity_id];
   await loadV2Customer(current().customer_id,{opportunityId:opportunity.opportunity_id});toast('已记录销售确认可用的识别内容；现在可以进入后续分析。');
  }catch(error){toast(error.message);}finally{mediaTranscriptionRuntime.busy='';render();}
 }
});

window.addEventListener('pagehide',()=>Object.values(mediaTranscriptionRuntime.byOpportunity).forEach(item=>item.url&&URL.revokeObjectURL(item.url)));
