const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPlanHarness(){
 const elements=new Map();
 const get=key=>{if(!elements.has(key))elements.set(key,{innerHTML:'',textContent:'',value:'',open:false,addEventListener(){},classList:{add(){},remove(){}},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(key);};
 const ctx=vm.createContext({console,Intl,Date,Set,JSON,Object,Array,String,Number,RegExp,Promise,AbortController,Math,
  document:{querySelector:get,addEventListener(){}},window:{addEventListener(){},scrollTo(){}},
  localStorage:{getItem(){return null;},setItem(){}},setInterval(){},setTimeout(){},clearTimeout(){}});
 for(const name of ['app.js','modules.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../../dist',name),'utf8'),ctx,{filename:name});
 return {evaluate:code=>vm.runInContext(code,ctx),ctx};
}

module.exports={createPlanHarness};
