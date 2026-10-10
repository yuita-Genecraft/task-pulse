// Wrangler's actual local D1 binding + Worker HTTP, not the mocked D1 fixture.
// No Cloudflare account, production database, or API credential is used.
import test from "node:test";
import assert from "node:assert/strict";

const BASE = "http://127.0.0.1:8798";
const SITE = "https://yuita-genecraft.github.io";
const EXT = "chrome-extension://" + "a".repeat(32);
const R = "local-test-read-token-aaaaaaaaaaaaaaaaaa";
const W = "local-test-write-token-bbbbbbbbbbbbbbbbbb";
const C = "local-test-capture-token-cccccccccccccccccc";
const ID = "6ac8be6a-bcb4-83ec-88fa-32d79a3cddf4";
const ID2 = "c34bf78a-9745-456b-8b6a-d00f9221c222";
const URL = "https://chatgpt.com/c/" + ID;
const U2 = "https://chatgpt.com/g/g-accepted_pj/c/" + ID2;
const observedAt = () => new Date().toISOString();

async function send(path, {method = "GET", token = "", body, origin = SITE} = {}) {
  const response = await fetch(BASE + path, {
    method, headers: {
      Origin: origin,
      ...(token ? {Authorization: "Bearer " + token} : {}),
      ...(body ? {"Content-Type":"application/json"} : {}),
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  let json = {};
  try { json = await response.json(); } catch {}
  return {response, json};
}
async function waitForServer() {
  let last;
  for (let i=0;i<80;i++) {
    try {
      const result = await send("/chats", {token:R});
      // If schema is absent, the Worker returns 500; that's not ready.
      if (result.response.status === 200) return;
      last = new Error("readiness status=" + result.response.status);
    } catch(e) { last = e; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw last || new Error("Worker never became ready");
}

test("Wrangler local D1: schema + auth + CAS + close/reopen + import", {timeout: 60000}, async () => {
  await waitForServer();
  let x = await send("/chats", {token: W});
  assert.equal(x.response.status,404,"write token must not read list");
  x = await send("/chats", {token: R, origin:"https://evil.example"});
  assert.equal(x.response.status,404,"cross-site reads must not be allowed");
  x = await send("/capture", {method:"POST",token:R,body:{url:URL,title:"no",observedAt:observedAt()}});
  assert.equal(x.response.status,404,"read token must not capture");
  x = await send("/chats/"+ID, {method:"PATCH",token:C,body:{action:"close",baseRevision:0}});
  assert.equal(x.response.status,404,"capture token must not mutate");

  x = await send("/capture", {method:"POST",token:C,body:{url:URL+"?bad=a#fragment",title:"First",observedAt:observedAt()}});
  assert.equal(x.response.status,200,JSON.stringify(x.json));
  x = await send("/chats", {token:R});
  assert.equal(x.response.status,200,JSON.stringify(x.json));
  assert.equal(x.json.total,1);
  assert.equal(x.json.chats[0].url,URL,"no query/fragment stored");
  assert.equal(x.json.chats[0].revision,0);
  const early = "2026-01-01T00:00:00.000Z";
  x = await send("/capture", {method:"POST",token:C,body:{url:URL,title:"Old title",observedAt:early}});
  assert.equal(x.response.status,200);
  x = await send("/chats", {token:R});
  assert.equal(x.json.chats[0].title,"First");

  x = await send("/chats/"+ID, {method:"PATCH",token:W,body:{action:"memo",baseRevision:0,memo:"first memo"}});
  assert.equal(x.response.status,200,JSON.stringify(x.json));
  assert.equal(x.json.chat.memo,"first memo");
  assert.equal(x.json.chat.revision,1);
  x = await send("/chats/"+ID, {method:"PATCH",token:W,body:{action:"memo",baseRevision:0,memo:"overwrite"}});
  assert.equal(x.response.status,409,"stale revision must fail");
  assert.equal(x.json.chat.memo,"first memo");

  x = await send("/chats/"+ID, {method:"PATCH",token:W,body:{action:"close",baseRevision:1}});
  assert.equal(x.response.status,200);
  assert.equal(x.json.chat.revision,2);
  assert.ok(x.json.chat.closedAt);
  x = await send("/capture", {method:"POST",token:C,body:{url:URL,title:"Captured while closed",observedAt:observedAt()}});
  assert.equal(x.response.status,200);
  x = await send("/chats", {token:R});
  assert.equal(x.json.chats[0].memo,"first memo");
  assert.equal(x.json.chats[0].revision,2);
  assert.ok(x.json.chats[0].closedAt,"capture must not reopen a closed chat");
  x = await send("/chats/"+ID, {method:"PATCH",token:W,body:{action:"reopen",baseRevision:2}});
  assert.equal(x.response.status,200);
  assert.equal(x.json.chat.closedAt,null);

  const imported = {url:U2,title:"Imported",observedAt:observedAt(),memo:"local memo",closedAt:null};
  x = await send("/import",{method:"POST",token:C,body:imported});
  assert.equal(x.response.status,404,"capture token must not import");
  x = await send("/import",{method:"POST",token:W,body:imported});
  assert.equal(x.response.status,200,JSON.stringify(x.json));
  assert.equal(x.json.inserted,true);
  x = await send("/import",{method:"POST",token:W,body:{...imported,title:"Overwrite",memo:"erase"}});
  assert.equal(x.response.status,200);
  assert.equal(x.json.inserted,false);
  x = await send("/chats",{token:R});
  const ir = x.json.chats.find(v=>v.id===ID2);
  assert.equal(ir.memo,"local memo");
  assert.equal(ir.title,"Imported");

  x = await send("/capture",{method:"POST",token:C,body:{url:"https://chatgpt.com/share/"+ID,title:"bad",observedAt:observedAt()}});
  assert.equal(x.response.status,400,"shared links must never be registered");
  x = await send("/chats/"+ID2,{method:"PATCH",token:W,body:{action:"memo",baseRevision:0,memo:"x".repeat(501)}});
  assert.equal(x.response.status,400,"memo length ceiling must reject");

  x = await send("/capture",{method:"OPTIONS",origin:EXT});
  assert.equal(x.response.status,204);
  assert.equal(x.response.headers.get("access-control-allow-origin"),EXT);
  x = await send("/chats",{method:"OPTIONS",origin:EXT});
  assert.equal(x.response.status,404,"extension origin may only access capture");

  // Parallel stale writers must not silently overwrite each other.
  const racing = await Promise.all([
    send("/chats/"+ID2,{method:"PATCH",token:W,body:{action:"memo",baseRevision:0,memo:"race memo"}}),
    send("/chats/"+ID2,{method:"PATCH",token:W,body:{action:"close",baseRevision:0}}),
  ]);
  assert.deepEqual(racing.map(z=>z.response.status).sort(),[200,409],"exactly one concurrent CAS write succeeds");
  x = await send("/chats",{token:R});
  assert.equal(x.response.status,200);
  assert.equal(x.json.total,2,"no duplicates or corruption");
  const afterRace = x.json.chats.find(v=>v.id===ID2);
  assert.equal(afterRace.revision,1);
  const memoWon = afterRace.memo === "race memo" && afterRace.closedAt === null;
  const closeWon = afterRace.memo === "local memo" && !!afterRace.closedAt;
  assert.ok(memoWon || closeWon,"the single successful patch persists atomically");
});
