import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { executeLegacyOutput } from './legacy-output.ts';
import type { ExecuteRequest } from '../agent-contract.ts';

function request(mode: ExecuteRequest['mode'] = 'research'): ExecuteRequest {
  const r = JSON.parse(readFileSync(new URL('../../../validation/agent/contracts/analyze-valid.json', import.meta.url), 'utf8')).request;
  r.mode = mode;
  r.input.question = mode === 'research' ? '有哪些进展？' : '';
  r.policy.deadline_at = new Date(Date.now() + 60000).toISOString();
  r.policy.max_model_calls = 2;
  return r;
}
const answer = (r: ExecuteRequest) => ({ title: '进展', content: '依据材料', insufficient_evidence: false, citations: [{ evidence_id: r.input.sources[0].evidence_id, quote: r.input.sources[0].text.slice(0, 30) }] });

test('invalid citation is repaired once with exact source contract', async () => {
  const r = request(); let calls = 0;
  const result = await executeLegacyOutput(r, async (_system, prompt) => {
    assert.match(prompt, /逐字/);
    if (calls++) assert.match(prompt, /上一次输出校验失败/);
    return { ok: true, model: 'offline', text: JSON.stringify(calls === 1 ? { ...answer(r), citations: [{ evidence_id: 'invented', quote: '改写' }] } : answer(r)) };
  });
  assert.equal(result.ok, true); assert.equal(result.runtime?.model_calls, 2);
});
test('repeated invalid quotes remain failures and calls are bounded', async () => {
  const r = request(); let calls = 0;
  const result = await executeLegacyOutput(r, async () => {
    calls++; return { ok: true, model: 'offline', text: JSON.stringify({ ...answer(r), citations: [{ evidence_id: r.input.sources[0].evidence_id, quote: '不存在的原文 xyz' }] }) };
  });
  assert.equal(result.ok, false); assert.equal(result.error?.code, 'invalid_citation'); assert.equal(calls, 2);
  assert.equal('result' in result, false);
});
test('oversized labels are rejected then corrected within the same budget', async () => {
  const r = request('analyze_item'); let calls = 0;
  const result = await executeLegacyOutput(r, async () => ({ ok: true, model: 'offline', text: JSON.stringify({ summary: '摘要', insights: '', topics: Array.from({length: ++calls === 1 ? 13 : 12}, (_, i) => `主题${i}`), tags: [], entities: [], citations: [], insufficient_evidence: true }) }));
  assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(result.result?.analysis?.topics.length, 12);
});
test('briefing has its own task and transport failures are not retried', async () => {
  let calls = 0;
  const result = await executeLegacyOutput(request('briefing'), async (_s, prompt) => {
    calls++; assert.match(prompt, /生成行业简报/); assert.match(prompt, /不需要用户问题/);
    return { ok: false, error: 'offline transport failure' };
  });
  assert.equal(result.ok, false); assert.equal(calls, 1);
});
test('expired deadline prevents any model call', async () => {
  const r = request(); r.policy.deadline_at = '2000-01-01T00:00:00Z';
  await executeLegacyOutput(r, async () => { throw new Error('unexpected call'); });
});

test('a timeout is reported with call accounting instead of escaping as generic analysis failure', async () => {
  let calls = 0;
  const result = await executeLegacyOutput(request(), async () => {
    calls++; throw new DOMException('sensitive upstream detail', 'TimeoutError');
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'model_timeout');
  assert.equal(result.error?.outcome_unknown, true);
  assert.equal(result.runtime?.model_calls, 1);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});
