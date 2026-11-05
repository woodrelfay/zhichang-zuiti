'use strict';
// tests/run.js — node tests/run.js
const assert = require('node:assert');
const { analyze, detectScenario } = require('../src/analyze');
const { checkReplyRisks } = require('../src/risk');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { console.error(`  ✘ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('职场嘴替 引擎测试');

test('承诺了明确截止时间的回复会被标高风险', () => {
  const risks = checkReplyRisks('没问题, 包在我身上, 周五前肯定给您');
  const hit = risks.find((r) => r.type === 'deadline_promise');
  assert.ok(hit, '应检出 deadline_promise');
  assert.strictEqual(hit.level, 'high');
});

test('被批评场景: 稳妥版不谄媚、不过度道歉', () => {
  const r = analyze({ text: '这个报表怎么又错了? 每次都粗心, 我很失望', relation: '直属领导', intent: '认错说明' });
  assert.strictEqual(r.scenario, 'criticism');
  const steady = r.replies.find((x) => x.label === '稳妥版');
  assert.ok(steady);
  const risks = checkReplyRisks(steady.text);
  assert.ok(!risks.some((x) => x.type === 'servile'), '稳妥版不应谄媚');
  assert.ok(!risks.some((x) => x.type === 'over_apology'), '稳妥版不应过度道歉');
  assert.ok(!/是是是|您说的都对|对不起对不起/.test(steady.text));
});

test('被加活: 抽出承诺任务和截止时间', () => {
  const r = analyze({ text: '顺便把上周的用户数据整理成表, 周五下班前给我', relation: '直属领导', intent: '确认任务' });
  assert.strictEqual(r.scenario, 'added_work');
  assert.ok(r.commitment.task && r.commitment.task.includes('用户数据'), `任务应含"用户数据", 实际: ${r.commitment.task}`);
  assert.ok(r.commitment.deadlineText && r.commitment.deadlineText.includes('周五'), `截止应含"周五", 实际: ${r.commitment.deadlineText}`);
  assert.strictEqual(r.commitment.needsConfirm, false);
});

test('下班后消息被识别为 after_hours 场景', () => {
  const s = detectScenario('在吗? 明天上班先把合同看一下, 急', '确认任务', 23);
  assert.strictEqual(s, 'after_hours');
  const r = analyze({ text: '在吗? 明天上班先把合同看一下, 急', relation: '直属领导', intent: '确认任务', hour: 23 });
  assert.strictEqual(r.scenario, 'after_hours');
  assert.ok(r.risks.some((x) => x.type === 'boundary'));
});

test('每个结果都有反面教材 (千万别这样回)', () => {
  const r = analyze({ text: '方案进度怎么样了? 客户等着用', relation: '客户', intent: '汇报进度' });
  assert.ok(r.antiExample && r.antiExample.text.length > 0 && r.antiExample.reason.length > 0);
});

test('回复恒为 3 个版本且标签固定', () => {
  const cases = [
    { text: '这个报表怎么又错了? 太慢了', relation: '直属领导', intent: '认错说明' },
    { text: '另外再做一版海报, 明天给我', relation: '大领导', intent: '委婉拒绝' },
    { text: '进度到哪一步了?', relation: '同事', intent: '汇报进度' },
  ];
  for (const c of cases) {
    const r = analyze(c);
    assert.strictEqual(r.replies.length, 3);
    assert.deepStrictEqual(r.replies.map((x) => x.label), ['稳妥版', '不卑不亢版', '推进版']);
    for (const rep of r.replies) assert.ok(rep.riskNote && rep.riskNote.length > 0);
  }
});

test('无截止时间的新任务会要求反问确认', () => {
  const r = analyze({ text: '另外帮我做一份竞品分析', relation: '直属领导', intent: '确认任务' });
  assert.strictEqual(r.commitment.needsConfirm, true);
  assert.ok(r.risks.some((x) => x.type === 'no_deadline'));
});

test('潜台词不为空且带原文依据', () => {
  const r = analyze({ text: '进度怎么样了, 什么时候能给我?', relation: '直属领导', intent: '汇报进度' });
  assert.ok(r.subtext.line.length >= 10);
  assert.ok(r.subtext.evidence.includes('原文依据') || r.subtext.evidence.includes('依据'));
});

test('只回"收到"在有任务时被判模糊确认风险', () => {
  const risks = checkReplyRisks('收到', { hasTask: true });
  assert.ok(risks.some((x) => x.type === 'vague_ack'));
});

console.log(`\n${passed} 个测试通过${process.exitCode ? ' (有失败)' : ''}`);

// ---------- 大模型层测试 (本地 mock, 不连真实 API) ----------
const { startMockLLM } = require('./mock-llm');
const { analyzeWithLLM, analyzeImageWithLLM, getConfig } = require('../src/llm');

let llmPassed = 0;
async function atest(name, fn) {
  try { await fn(); llmPassed++; console.log(`  ✔ ${name}`); }
  catch (e) { console.error(`  ✘ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

function setEnv(port, key) {
  process.env.ZUITI_LLM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ZUITI_LLM_API_KEY = key || 'test-key';
  process.env.ZUITI_LLM_MODEL = 'mock-model';
  delete process.env.ZUITI_VISION_MODEL;
}
function clearEnv() {
  delete process.env.ZUITI_LLM_BASE_URL;
  delete process.env.ZUITI_LLM_API_KEY;
  delete process.env.ZUITI_LLM_MODEL;
  delete process.env.ZUITI_VISION_MODEL;
}

(async () => {
  console.log('\n职场嘴替 大模型层测试 (mock)');
  const good = startMockLLM({ port: 0, mode: 'good' });
  const bad = startMockLLM({ port: 0, mode: 'badjson' });
  await Promise.all([
    new Promise((r) => good.once('listening', r)),
    new Promise((r) => bad.once('listening', r)),
  ]);
  const goodPort = good.address().port;
  const badPort = bad.address().port;
  const sample = { text: '顺便把数据整理成表, 周五下班前给我', relation: '直属领导', intent: '确认任务' };
  try {
    await atest('LLM 路径返回 source=llm', async () => {
      setEnv(goodPort);
      assert.strictEqual(getConfig().configured, true);
      const r = await analyzeWithLLM(sample);
      assert.strictEqual(r.source, 'llm');
      assert.strictEqual(r.replies.length, 3);
    });

    await atest('LLM 回复必须过确定性风险校验 (埋雷回复被标出)', async () => {
      setEnv(goodPort);
      const r = await analyzeWithLLM(sample);
      const risky = r.replies.find((x) => x.text.includes('没问题'));
      assert.ok(risky, 'mock 应包含一条埋雷回复');
      assert.ok(risky.riskNote.includes('风险自检未通过'), `埋雷回复应未通过自检, 实际: ${risky.riskNote}`);
      const clean = r.replies.filter((x) => !x.text.includes('没问题'));
      for (const c of clean) assert.ok(c.riskNote.includes('通过确定性风险校验'), `干净回复应通过: ${c.riskNote}`);
    });

    await atest('LLM 返回坏 JSON 时回退规则引擎', async () => {
      setEnv(badPort);
      const r = await analyzeWithLLM(sample);
      assert.strictEqual(r.source, 'rules');
      assert.ok(r.llmError && r.llmError.length > 0);
      assert.strictEqual(r.replies.length, 3);
    });

    await atest('未配置 Key 时文本走规则引擎, 不抛错', async () => {
      clearEnv();
      assert.strictEqual(getConfig().configured, false);
      const r = await analyzeWithLLM(sample);
      assert.strictEqual(r.source, 'rules');
    });

    await atest('视觉 mock 返回 transcript 且 source=llm', async () => {
      setEnv(goodPort);
      const r = await analyzeImageWithLLM(Buffer.from('fakepng').toString('base64'), 'image/png', { relation: '直属领导', intent: '确认任务' });
      assert.strictEqual(r.source, 'llm');
      assert.ok(typeof r.transcript === 'string' && r.transcript.includes('领导'), `transcript 应含对话, 实际: ${r.transcript}`);
    });

    await atest('未配置时截图路径老实报错, 不伪造结果', async () => {
      clearEnv();
      const r = await analyzeImageWithLLM(Buffer.from('fakepng').toString('base64'), 'image/png', {});
      assert.strictEqual(r.error, 'vision_not_configured');
      assert.ok(!r.replies, '不应伪造回复');
    });
  } finally {
    good.close(); bad.close(); clearEnv();
  }
  console.log(`\n${llmPassed} 个大模型测试通过${process.exitCode ? ' (有失败)' : ''}`);
})().catch((e) => { console.error('大模型测试异常:', e); process.exitCode = 1; });
