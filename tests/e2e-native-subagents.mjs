// Opt-in acceptance: node tests/e2e-native-subagents.mjs <installed-pi-subagents-index> [read|write|shell|shell-abort|turn-limit|abort|missing-guard]
// Real Pi + pi-subagents, deterministic in-process provider, no remote model/API calls.
// Run from the kit root. Evidence is retained under OS temp; no user settings are changed.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { locatePiEntry } from '../adapters/pi/lib/invoke.mjs';
import { isolatedEnv } from '../adapters/pi/lib/startup-check.mjs';
const kit=resolve('.');
const owner=process.argv[2];
const scenario=process.argv[3]??'read';
if(!owner||!['read','write','turn-limit','shell','shell-abort','abort','missing-guard'].includes(scenario))throw Error('Usage: <installed pi-subagents extension entry> [read|write|turn-limit|shell|shell-abort|abort|missing-guard]');
const shellScenario=scenario==='shell'||scenario==='shell-abort';
const action=scenario==='write'?{type:'toolCall',id:'fixture-write',name:'write',arguments:{path:'native-output.txt',content:'fixture write\n'}}:shellScenario?{type:'toolCall',id:'fixture-shell',name:'ludi_exec',arguments:{command:scenario==='shell-abort'?'node --test slow.test.mjs':'node --test shell.test.mjs'}}:{type:'toolCall',id:'fixture-read',name:'read',arguments:{path:'fixture.txt'}};
const root=mkdtempSync(join(tmpdir(),'ludi-native-smoke-'));
const agent=join(root,'agent'),work=join(root,'work');
for(const dir of [agent,work,join(root,'tmp')])mkdirSync(dir,{recursive:true});
const resultPath=join(root,'result.json'),callsPath=join(root,'calls.jsonl');
writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],enableInstallTelemetry:false,enableAnalytics:false,defaultProjectTrust:'never',retry:{enabled:false},subagents:{defaultSubagentContext:'fresh'}}));
writeFileSync(join(work,'fixture.txt'),'native fixture\n');
writeFileSync(join(work,'shell.test.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync('shell-ran.txt','native shell ran');`);
writeFileSync(join(work,'slow.test.mjs'),`import test from 'node:test';import {writeFileSync,renameSync} from 'node:fs';test('wait for controlled abort',async()=>{writeFileSync('started.tmp',JSON.stringify({pid:process.pid,ppid:process.ppid}));renameSync('started.tmp','started.json');await new Promise(resolve=>setTimeout(resolve,30000));});`);
const extension=join(root,'fixture.mjs');
const nativeUrl=pathToFileURL(join(kit,'adapters/pi/lib/native-subagent.mjs')).href;
writeFileSync(extension,`import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/compat';
import {appendFileSync,writeFileSync,rmSync,watch} from 'node:fs';
import {createNativeSubagentRunner,RUNTIME_AGENT_REGISTER_EVENT} from ${JSON.stringify(nativeUrl)};
const RESULT=${JSON.stringify(resultPath)}, CALLS=${JSON.stringify(callsPath)}, WORK=${JSON.stringify(work)}, ACTION=${JSON.stringify(action)}, MODE=${JSON.stringify(scenario)};
let activeController;
const text=JSON.stringify({status:'completed',summary:'固定応答の native 接続確認',acceptance:[{id:'A1',met:true,evidence:'local fixture'}],filesChanged:[],commandsRun:[],verification:[],remainingIssues:[],reviewFindings:[],decisions:[],newTasks:[]});
export default function fixture(pi){
 const shellWatcher=MODE==='shell-abort'?watch(WORK,(_event,name)=>{
   if(name==='started.json')activeController?.abort('controlled fixture shell abort');
 }):null;
 shellWatcher?.unref();
 pi.registerProvider('ludi-native-fixture',{api:'ludi-native-fixture-api',baseUrl:'http://127.0.0.1/never-used',apiKey:'fixture-only',models:[{id:'fixed',name:'Local fixed fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048}],streamSimple(model,context,options){
 const stream=createAssistantMessageEventStream();
 queueMicrotask(()=>{appendFileSync(CALLS,JSON.stringify({provider:model.provider,model:model.id,aborted:options?.signal?.aborted===true,readVerified:MODE==='read'&&context.messages.some(m=>m.role==='toolResult'&&m.content?.some(c=>c.type==='text'&&c.text.includes('native fixture')))})+'\\n');
 const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
 if(MODE==='abort'){
   stream.push({type:'start',partial:message});
   const abort=()=>{message.stopReason='aborted';message.errorMessage='controlled fixture abort';stream.push({type:'error',reason:'aborted',error:message});stream.end();};
   options.signal.addEventListener('abort',abort,{once:true});
   if(options.signal.aborted)abort();else setTimeout(()=>activeController.abort(),20);
   return;
 }
 const hasResult=context.messages.some(m=>m.role==='toolResult');
 message.content=hasResult?[{type:'text',text:String.fromCharCode(96).repeat(3)+'json\\n'+text+'\\n'+String.fromCharCode(96).repeat(3)}]:[ACTION];
 message.stopReason=hasResult?'stop':'toolUse';
 stream.push({type:'start',partial:message});
 if(hasResult){stream.push({type:'text_start',contentIndex:0,partial:message});stream.push({type:'text_delta',contentIndex:0,delta:message.content[0].text,partial:message});stream.push({type:'text_end',contentIndex:0,content:message.content[0].text,partial:message});}
 else{stream.push({type:'toolcall_start',contentIndex:0,partial:message});stream.push({type:'toolcall_end',contentIndex:0,toolCall:message.content[0],partial:message});}
 stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;
 }});
 if(MODE==='missing-guard')pi.events.on(RUNTIME_AGENT_REGISTER_EVENT,request=>{
   if(request.name.startsWith('ludi-')&&request.definition?.subagentOnlyExtensions?.length===1)rmSync(request.definition.subagentOnlyExtensions[0]);
 });
 const native=createNativeSubagentRunner({pi,cancelGraceMs:1000});
 pi.registerCommand('ludi-native-smoke',{description:'Local-only native acceptance fixture',async handler(_args,ctx){
 activeController=new AbortController();
 // This driver owns a private disposable workspace; production writers use the runner's durable lease callback.
 const result=await native.runSubagent({protectWorkspace:()=>{},signal:activeController.signal,modelId:'ludi-native-fixture/fixed:off',agent:'scout',taskId:'smoke',runId:'fixture-owner',systemPrompt:'Return the local fixture result.',prompt:'Return a completed result.',cwd:WORK,toolNames:${JSON.stringify(shellScenario?['ludi_exec']:scenario==='write'?['read','write']:['read'])},access:{filesystem:${JSON.stringify(scenario==='write'?'read-write':'read')},shell:${JSON.stringify(shellScenario?'limited':'false')},network:false},limits:{max_runtime_ms:30000,max_turns:${scenario==='turn-limit'?1:2},max_tool_calls:2}});
 const {retainWorkspaceUntil,...safe}=result;writeFileSync(RESULT,JSON.stringify(safe,null,2));
 }});
 pi.on('session_shutdown',()=>{shellWatcher?.close();native.dispose();});
}
`);
const env=isolatedEnv(process.env,{agentDir:agent,root});
const proc=spawn(process.execPath,[locatePiEntry(),'--mode','rpc','--no-session','--no-tools','--no-skills','--offline','--no-mcp','--no-approve','--no-context-files','-e',owner,'-e',extension,'--model','ludi-native-fixture/fixed'],{cwd:work,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
let buffer='',stderr='';const events=[];let timer=setTimeout(()=>{proc.kill();},60000);
proc.stdout.setEncoding('utf8');proc.stderr.setEncoding('utf8');proc.stderr.on('data',s=>stderr+=s);
proc.stdout.on('data',chunk=>{buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.trim())continue;try{const e=JSON.parse(line);events.push(e);if(e.type==='response'&&e.id==='run'){proc.stdin.end();}}catch{events.push({diagnostic:line});}}});
proc.on('error',e=>console.error(e));
proc.on('close',code=>{
 clearTimeout(timer);
 writeFileSync(join(root,'rpc.json'),JSON.stringify(events,null,2));
 writeFileSync(join(root,'stderr.log'),stderr);
 let result=null,calls=null,shellStopped=null;
 try{result=JSON.parse(readFileSync(resultPath,'utf8'));}catch{}
 try{calls=readFileSync(callsPath,'utf8');}catch{}
 if(scenario==='shell-abort'){
   try{
     const ids=JSON.parse(readFileSync(join(work,'started.json'),'utf8'));
     shellStopped=[ids.pid,ids.ppid].every(pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
   }catch{shellStopped=false;}
 }
 console.log(JSON.stringify({root,scenario,exit:code,stderr,result,calls,shellStopped,responses:events.filter(e=>e.type==='response')},null,2));
 const count=(calls??'').trim().split(/\r?\n/).filter(Boolean).length;
 const accepted=scenario==='missing-guard'?result?.ok===false&&result.abort===true&&count===0:
   scenario==='turn-limit'?result?.ok===false&&result.child?.stopReason==='guard-turn-limit'&&count===1:
   scenario==='shell-abort'?result?.ok===false&&result.abort===true&&result.child?.guardQuiescent===true&&count===1&&shellStopped:
   scenario==='abort'?result?.ok===false&&result.abort===true&&result.child?.guardQuiescent===true&&count===1:
   result?.ok===true&&result.child?.guardQuiescent===true&&count===2
     &&(scenario!=='read'||(calls??'').trim().split(/\r?\n/).some(line=>JSON.parse(line).readVerified===true))
     &&(scenario!=='shell'||readFileSync(join(work,'shell-ran.txt'),'utf8')==='native shell ran')
     &&(scenario!=='write'||readFileSync(join(work,'native-output.txt'),'utf8')==='fixture write\n');
 process.exitCode=code!==0||!accepted?1:0;
});
proc.stdin.write(JSON.stringify({id:'run',type:'prompt',message:'/ludi-native-smoke'})+'\n');
