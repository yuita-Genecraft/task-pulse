const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname+'/capture.js','utf8');
function page() {
  const events={}, win={}, observers=[], timers=[], sent=[];
  let turns=[];
  const turn=id=>({id:'',getAttribute:n=>n==='data-turn-key'?id:null,
    querySelectorAll:()=>[{textContent:'あなたの発言:'}],
    get textContent(){throw Error('message body must not be read');}});
  turns=[turn('existing-user-turn')];
  const doc={visibilityState:'visible',title:'Existing title',documentElement:{},
    querySelector:()=>({}),querySelectorAll:()=>turns,
    addEventListener:(name,handler)=>{events[name]=handler;}};
  const context={document:doc,window:{addEventListener:(n,h)=>win[n]=h},
    location:{href:'https://chatgpt.com/c/01234567-89ab-4cde-8fab-0123456789ab'},
    MutationObserver:class{constructor(cb){this.cb=cb;}observe(){observers.push(this.cb);}},
    setTimeout:cb=>timers.push(cb),setInterval:()=>{},URL,Date,
    chrome:{runtime:{sendMessage:m=>{sent.push(m);return Promise.resolve({ok:true});}}}};
  vm.runInNewContext(source,context);
  return {sent,events,win,context,doc,
    interact(type,extra={}) {const button=extra.sendButton?{disabled:false,type:'submit',getAttribute:()=>null}:null;
      events[type]({type,isTrusted:true,key:'Enter',target:{closest:s=>s==='button'?button:{}},...extra});},
    mutate(id,prepend=false) {if(id) prepend?turns.unshift(turn(id)):turns.push(turn(id));
      observers.at(-1)();while(timers.length)timers.shift()();},
    replaceUnidentified(){turns=[turn(null)];observers.at(-1)();while(timers.length)timers.shift()();},
    titleMutation(){observers[0]();}};
}
test('existing same-URL chat registers a confirmed new instruction without reading text',()=>{
  const p=page();assert.equal(p.sent.length,1);
  p.interact('keydown');assert.equal(p.sent.length,1,'Enter alone is not evidence of submission');
  p.mutate('new-user-turn');assert.equal(p.sent.length,2);
  assert.ok(p.sent[1].activityAt);assert.equal(p.sent[1].url,p.sent[0].url);
  p.titleMutation();assert.equal(p.sent.length,2,'same title cannot overwrite instruction capture');
});
test('send-button submission works; focus, history prepend, IME and untrusted events do not resume',()=>{
  const click=page();click.interact('click',{sendButton:true});click.mutate('sent-by-button');
  assert.ok(click.sent[1].activityAt);
  const history=page();history.interact('click');history.mutate('older-history',true);
  assert.equal(history.sent.length,1);
  const line=page();line.interact('keydown',{shiftKey:true});line.mutate();assert.equal(line.sent.length,1);
  const ime=page();ime.interact('keydown',{isComposing:true});ime.mutate('not-a-submit');assert.equal(ime.sent.length,1);
  const synthetic=page();synthetic.interact('submit',{isTrusted:false});synthetic.mutate('synthetic');assert.equal(synthetic.sent.length,1);
});
test('navigation cancels an armed instruction and ordinary focus carries no resume signal',()=>{
  const p=page();p.interact('submit');p.context.location.href='https://chatgpt.com/c/11234567-89ab-4cde-8fab-0123456789ab';
  p.mutate('another-chat-user-turn');assert.equal(p.sent.length,1);
  p.win.focus();assert.equal(p.sent.length,2);assert.equal(p.sent[1].activityAt,undefined);
});
test('confirmed instruction is queued after the tab becomes hidden',()=>{
  const p=page();p.interact('keydown');p.doc.visibilityState='hidden';
  p.mutate('submitted-before-tab-switch');assert.equal(p.sent.length,2);assert.ok(p.sent[1].activityAt);
  p.win.focus();assert.equal(p.sent.length,2,'hidden ordinary observation stays silent');
});

test('remounting a turn without a stable identifier cannot resume a chat',()=>{
  const p=page();p.replaceUnidentified();p.interact('keydown');p.replaceUnidentified();
  assert.equal(p.sent.length,1);
});
