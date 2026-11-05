#!/usr/bin/env node
'use strict';
// cli.js — 命令行 demo
// 用法:
// node src/cli.js --text "顺便把上周的数据整理一下, 周五下班前给我" --relation 直属领导 --intent 确认任务
// node src/cli.js --text "..." --json
// echo '{"text":"...","relation":"客户","intent":"争取时间"}' | node src/cli.js --stdin --json

const { analyze, RELATIONS, INTENTS} = require('./analyze');

function parseArgs(argv) {
const args = { json: false, stdin: false};
for (let i = 2; i < argv.length; i++) {
const a = argv[i];
if (a === '--json') args.json = true;
else if (a === '--stdin') args.stdin = true;
else if (a === '--text') args.text = argv[++i];
else if (a === '--relation') args.relation = argv[++i];
else if (a === '--intent') args.intent = argv[++i];
else if (a === '--hour') args.hour = Number(argv[++i]);
else if (a === '--help' || a === '-h') args.help = true;
}
return args;
}

function printReport(r) {
const line = '─'.repeat(56);
console.log(`\n${r.scenarioName} ${r.relation} ${r.intent}`);
console.log(line);
console.log(`🧭 潜台词: ${r.subtext.line}`);
console.log(` ${r.subtext.evidence}`);
if (r.risks.length) {
console.log('\n⚠️ 风险提示:');
for (const x of r.risks) console.log(` [${x.level === 'high'? '高': '中'}] ${x.detail}`);
}
console.log('\n📌 承诺抽取:');
console.log(` 任务: ${r.commitment.task || '(本次无新任务)'}`);
console.log(` 截止: ${r.commitment.deadlineText || '未给出'}`);
console.log(` 需要反问确认: ${r.commitment.needsConfirm? '是 — 回复里必须带确认动作': '否'}`);
console.log('\n💬 可直接发的回复 (3 个版本):');
for (const rep of r.replies) {
console.log(`\n ▶ ${rep.label}: ${rep.text}`);
console.log(` (${rep.riskNote})`);
}
console.log('\n🚫 千万别这样回:');
console.log(` 「${r.antiExample.text}」`);
console.log(` 原因: ${r.antiExample.reason}\n`);
}

async function main() {
const args = parseArgs(process.argv);
if (args.help) {
console.log('职场嘴替 (工作版) CLI');
console.log('--text <消息原文> --relation <' + RELATIONS.join('|') + '>');
console.log('--intent <' + INTENTS.join('|') + '> --hour <0-23> --json --stdin');
return;
}
let input = { text: args.text, relation: args.relation, intent: args.intent, hour: args.hour};
if (args.stdin ||!args.text) {
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString('utf8').trim();
if (raw) {
try { input = {...input,...JSON.parse(raw)};}
catch { input.text = raw;}
}
}
if (!input.text) {
console.error('缺少 --text, 例: node src/cli.js --text "在吗, 明天把方案发我" --relation 直属领导');
process.exit(2);
}
const result = analyze(input);
if (args.json) console.log(JSON.stringify(result, null, 2));
else printReport(result);
}

main().catch((e) => { console.error('错误:', e.message); process.exit(1);});
