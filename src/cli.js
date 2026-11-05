#!/usr/bin/env node
'use strict';
// cli.js — 命令行 demo
// 用法:
// node src/cli.js --text "顺便把上周的数据整理一下, 周五下班前给我" --relation 直属领导 --intent 确认任务
// node src/cli.js --text "..." --json
// node src/cli.js --text "..." --llm (配置了 ZUITI_LLM_* 时走大模型, 失败自动回退规则引擎)
// node src/cli.js --image ./chat.png --relation 直属领导 (截图识别, 必须配置大模型)
// echo '{"text":"...","relation":"客户","intent":"争取时间"}' | node src/cli.js --stdin --json

const fs = require('fs');
const path = require('path');
const { analyze, RELATIONS, INTENTS} = require('./analyze');
const { analyzeWithLLM, analyzeImageWithLLM} = require('./llm');

function parseArgs(argv) {
const args = { json: false, stdin: false, llm: false};
for (let i = 2; i < argv.length; i++) {
const a = argv[i];
if (a === '--json') args.json = true;
else if (a === '--stdin') args.stdin = true;
else if (a === '--llm') args.llm = true;
else if (a === '--image') args.image = argv[++i];
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
if (r.transcript) {
console.log('\n📷 截图转录:');
console.log(r.transcript);
}
console.log(`\n${r.scenarioName} ${r.relation} ${r.intent}`);
if (r.source) {
console.log(`来源: ${r.source === 'llm'? '大模型': '规则引擎'}${r.llmError? ` (大模型不可用, 已回退: ${r.llmError})`: ''}`);
}
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
console.log('--llm 走大模型 (需配置 ZUITI_LLM_BASE_URL / ZUITI_LLM_API_KEY / ZUITI_LLM_MODEL, 失败自动回退规则引擎)');
console.log('--image <截图路径> 识别聊天截图 (需配置大模型/视觉模型 ZUITI_VISION_MODEL, 未配置时如实报错)');
return;
}
if (args.image) {
const ext = path.extname(args.image).toLowerCase();
const mime = ext === '.png'? 'image/png': (ext === '.jpg' || ext === '.jpeg')? 'image/jpeg': ext === '.webp'? 'image/webp': 'image/png';
let base64;
try { base64 = fs.readFileSync(args.image).toString('base64');}
catch (e) { console.error('错误: 读不到截图文件:', e.message); process.exit(1);}
const imgResult = await analyzeImageWithLLM(base64, mime, { relation: args.relation, intent: args.intent, hour: args.hour});
if (imgResult.error) {
if (args.json) console.log(JSON.stringify(imgResult, null, 2));
else console.error(imgResult.message);
process.exit(1);
}
if (args.json) console.log(JSON.stringify(imgResult, null, 2));
else printReport(imgResult);
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
const result = args.llm? await analyzeWithLLM(input): analyze(input);
if (args.json) console.log(JSON.stringify(result, null, 2));
else printReport(result);
}

main().catch((e) => { console.error('错误:', e.message); process.exit(1);});
