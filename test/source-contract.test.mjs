import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {SourceClient, assertLocalSource} from '../src/client.mjs';
import {makeHarness, sourceApi} from './helpers.mjs';

test('来源拒绝非本机地址，采集端不可能调用真实付费接口', () => {
  assert.ok(assertLocalSource('http://127.0.0.1:1234'));
  assert.ok(assertLocalSource('http://localhost:1234'));
  assert.throws(() => assertLocalSource('https://api.example.com'), /协议|回环/);
  assert.throws(() => assertLocalSource('https://127.0.0.1:1234'), /http/);
  assert.throws(() => new SourceClient('http://api.example.com'), /回环/);
});

test('来源报价、查单与结果读取使用本地合成数据', async t => {
  const source = await createSource();
  t.after(() => source.close());
  const client = new SourceClient(source.url);
  const quote = await client.quote();
  assert.deepEqual(quote, {price: 3, datasetVersion: 1});
  const purchase = await client.purchase({requestId: 'r1', purpose: '研究', version: 1, maxPrice: 3});
  assert.equal(purchase.status, 200);
  assert.equal(purchase.value.charged, 3);
  assert.equal((await client.order('r1')).status, 200);
  const result = await client.result('r1');
  assert.equal(result.status, 200);
  assert.equal(result.value.records[0].id, 'enterprise-1');
  assert.match(result.text, /合成资料/);
});

test('相同请求号不产生第二次披露，换用途冲突', async t => {
  const source = await createSource();
  t.after(() => source.close());
  const api = sourceApi(source);
  const body = {requestId: 'r1', purpose: '研究', version: 1, maxPrice: 4};
  assert.equal((await api('/purchase', {method: 'POST', body})).value.charged, 3);
  await api('/purchase', {method: 'POST', body});
  assert.equal(Object.keys(source.state.orders).length, 1);
  assert.equal((await api('/purchase', {method: 'POST', body: {...body, purpose: '转售'}})).status, 409);
  assert.equal((await api('/purchase', {method: 'POST', body: {...body, version: 2}})).status, 409);
});

test('来源只接受受控字段，防止测试绕过领域约束', async t => {
  const source = await createSource();
  t.after(() => source.close());
  const api = sourceApi(source);
  assert.equal((await api('/control', {method: 'POST', body: {orders: {fake: {}}}})).status, 400);
  assert.equal((await api('/control', {method: 'POST', body: {price: -1}})).status, 400);
  assert.equal((await api('/control', {method: 'POST', body: {limit: 2}})).status, 400);
  await api('/purchase', {method: 'POST', body: {requestId: 'r1', purpose: '研究', version: 1, maxPrice: 3}});
  await api('/control', {method: 'POST', body: {complete: true}});
  assert.equal((await api('/results/r1')).status, 200);
});

test('来源报价上涨时以 402 拒绝受理且不建立披露', async t => {
  const source = await createSource();
  t.after(() => source.close());
  const api = sourceApi(source);
  await api('/control', {method: 'POST', body: {price: 9}});
  const response = await api('/purchase', {method: 'POST', body: {requestId: 'r1', purpose: '研究', version: 1, maxPrice: 3}});
  assert.equal(response.status, 402);
  assert.equal(response.value.price, 9);
  assert.equal(Object.keys(source.state.orders).length, 0);
});

test('账本原子写入，损坏的账本不会被当成空账本覆盖', async t => {
  const harness = await makeHarness(t);
  const {LedgerStore} = await import('../src/store.mjs');
  const ledgerPath = harness.ledgerPath;
  const ledger = new LedgerStore(ledgerPath);
  assert.deepEqual(await ledger.load(), {schema: 1, sequence: 0, orders: {}, lines: {}, disclosures: {}, events: []});
  await ledger.update(draft => { draft.orders.a = {id: 'a'}; });
  const {writeFile, readFile} = await import('node:fs/promises');
  const before = await readFile(ledgerPath, 'utf8');
  await writeFile(ledgerPath, '{broken');
  await assert.rejects(() => ledger.load(), /JSON/);
  // A rejected transaction leaves the file untouched.
  await assert.rejects(() => ledger.update(() => { throw new Error('拒绝'); }), /拒绝/);
  assert.equal(await readFile(ledgerPath, 'utf8'), '{broken');
  assert.ok(before.includes('"orders"'));
});
