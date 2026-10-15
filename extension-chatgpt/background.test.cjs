const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/background.js','utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('instruction time survives a later ordinary capture and an in-flight upload',async()=>{
 const data={},uploads=[];let listener,alarm,release,held=true;
 const context={URL,Date,fetch:async(url,options)=>{
   if(url.startsWith('chrome-extension:'))return {json:async()=>({captureToken:'c'.repeat(40)})};
   uploads.push(JSON.parse(options.body));
   if(held){held=false;await new Promise(resolve=>release=resolve);}
   return {ok:true};
 },chrome:{storage:{local:{setAccessLevel:async()=>{},get:async keys=>{
   if(keys===null)return structuredClone(data);if(typeof keys==='string')keys=[keys];
   return Object.fromEntries(keys.filter(k=>Object.hasOwn(data,k)).map(k=>[k,structuredClone(data[k])]));
 },set:async values=>Object.assign(data,structuredClone(values)),remove:async key=>{delete data[key];}}},
 runtime:{getURL:p=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:{addListener:f=>listener=f},onStartup:{addListener:()=>{}}},
 alarms:{create:async()=>{},onAlarm:{addListener:f=>alarm=f}}}};
 vm.runInNewContext(source,context);
 for(let i=0;i<5;i++)await tick();
 const url='https://chatgpt.com/g/g-p-6ab08ead99b88191ab18129fe14730d9-claudesekantoohinion/c/01234567-89ab-4cde-8fab-0123456789ab';
 const send=m=>new Promise(resolve=>listener({type:'capture',url,title:'same',...m},{url},resolve));
 assert.equal((await send({url:'https://chatgpt.com/c/01234567-89ab-4cde-8fab-0123456789ab'})).ok,false);
 assert.equal(uploads.length,0,'out-of-project input cannot be uploaded');
 assert.equal((await send({})).ok,true);
 for(let i=0;i<20&&!release;i++)await tick();assert.ok(release);
 const activityAt=new Date(Date.now()-1000).toISOString();
 assert.equal((await send({activityAt})).ok,true);
 assert.equal((await send({title:'renamed'})).ok,true);
 release();for(let i=0;i<30;i++)await tick();
 assert.ok(uploads.some(p=>p.activityAt===activityAt&&p.title==='renamed'));
 assert.equal(Object.keys(data).filter(k=>k.startsWith('tp_pending_')).length,0);
 assert.equal(data['tp_gpt_01234567-89ab-4cde-8fab-0123456789ab'].activityAt,activityAt);
 const before=uploads.length;alarm({name:'capture-retry'});for(let i=0;i<5;i++)await tick();assert.equal(uploads.length,before);
 const leave=raw=>new Promise(resolve=>listener({type:'leaveProject',url:raw},{url:raw},resolve));
 const outside='https://chatgpt.com/c/01234567-89ab-4cde-8fab-0123456789ab';
 assert.equal((await leave(outside)).ok,true);for(let i=0;i<10;i++)await tick();
 assert.equal(uploads.at(-1).action,'leaveProject');assert.equal(uploads.at(-1).title,undefined);
 assert.equal(data['tp_gpt_01234567-89ab-4cde-8fab-0123456789ab'].outOfProject,true);
 const count=uploads.length;await leave('https://chatgpt.com/c/f1234567-89ab-4cde-8fab-0123456789ab');
 for(let i=0;i<5;i++)await tick();assert.equal(uploads.length,count,'never-tracked outside chats are not sent to server');
});
