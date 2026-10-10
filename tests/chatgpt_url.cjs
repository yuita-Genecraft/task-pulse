// Browser-independent deterministic checks for ChatGPT URL/title normalization.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt.js'), 'utf8');
const defs = [
  source.match(/^  const uuid = .*;$/m)?.[0],
  source.match(/^  const pathRe = .*;$/m)?.[0],
  source.match(/  const cleanTitle = \(s\) => \{[\s\S]*?\n  \};/)?.[0],
  source.match(/  function canonical\(raw\) \{[\s\S]*?\n  \}\n  function validTime/)?.[0]?.replace(/\n  function validTime$/, ''),
];
assert(defs.every(Boolean), 'normalizer source missing');
const { canonical, cleanTitle } = new Function(defs.join('\n') + '\nreturn {canonical,cleanTitle}')( );
const id = '01234567-89ab-4cde-8fab-0123456789ab';
const root = 'https://chatgpt.com/c/' + id;
const project = 'https://chatgpt.com/g/g-12345-test/c/' + id;
assert.deepEqual(canonical(root), { id, url: root });
assert.deepEqual(canonical(root.slice(0,-36) + id.toUpperCase()), { id, url: root });
assert.deepEqual(canonical(project + '?sensitive=1#secret'), { id, url: project });
assert.equal(canonical(root.replace('/c/', '/C/')), null);
for (const s of [
  'http://chatgpt.com/c/' + id,
  'https://chatgpt.com.evil.org/c/' + id,
  'https://user:pass@chatgpt.com/c/' + id,
  'https://chatgpt.com:4433/c/' + id,
  'https://chatgpt.com/share/' + id,
  'https://chatgpt.com/c/' + id + '/other',
  'https://chatgpt.com/g/other/c/' + id,
  'javascript:alert(1)',
  'https://chatgpt.com/c/no-id',
]) assert.equal(canonical(s), null, s);
assert.equal(cleanTitle('テスト - ChatGPT'), 'テスト');
assert.equal(cleanTitle('隠し\u202e表示'), '隠し 表示');
assert.equal(cleanTitle('ChatGPT'), '');
assert.equal([...cleanTitle('あ'.repeat(200))].length, 120);
console.log('PASS 15 normalizer assertions');
