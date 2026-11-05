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
