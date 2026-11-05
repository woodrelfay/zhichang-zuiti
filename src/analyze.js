'use strict';
// analyze.js — 职场嘴替 (工作版) 核心引擎 (离线规则版)
// 设计原则: 先翻译潜台词 -> 再标风险 -> 抽承诺 -> 最后才给话术。
// 与通用"高情商话术"的区别就在前三步, 话术只是最后的出口。

const risk = require('./risk');

const RELATIONS = ['直属领导', '大领导', '客户', 'HR', '同事'];
const INTENTS = ['争取时间', '委婉拒绝', '认错说明', '汇报进度', '确认任务', '请示确认'];

// ---------- 场景识别: 只做 5 个初入职场的高频时刻 ----------
function detectScenario(text, intent, hour) {
  const t = text || '';
  if (risk.isAfterHoursHint(t, hour) && /(在吗|睡了吗|明天|周一|上班|先看|先处理|急)/.test(t)) {
    return 'after_hours';
  }
  if (/(怎么还没|为什么|失望|注意一下|又错|搞什么|太慢了|不满意|粗心|返工)/.test(t)) {
    return 'criticism';
  }
  if (/(顺便|另外|再帮|再做|加一个|新需求|你来负责|安排给你|帮忙做|抽空把)/.test(t)) {
    return 'added_work';
  }
  if (/(进度|到哪一步|怎么样了|好了没|什么时候能|何时能|催一下|等着用)/.test(t)) {
    return 'chasing';
  }
  if (intent === '汇报进度' && /(延期|做不完|来不及|出了问题|卡住|风险|故障|报错)/.test(t)) {
    return 'bad_news';
  }
  if (intent === '汇报进度') return 'chasing';
  // 兜底: 有明确交付物+时间 = 新增任务; 其余按确认任务处理
  if (risk.extractDeadline(t) && /(做|写|改|整理|出|给|交|发)/.test(t)) return 'added_work';
  return 'confirm_task';
}

const SCENARIO_NAMES = {
  criticism: '被批评',
  added_work: '被加活/临时加任务',
  chasing: '被催进度',
  bad_news: '汇报坏消息/延期',
  after_hours: '下班后/休息时间收到工作消息',
  confirm_task: '确认任务',
};

// ---------- 承诺抽取: 把聊天变成"任务 + 截止" ----------
function extractTask(text) {
  let t = (text || '').replace(/\s+/g, ' ').trim();
  // 去掉称呼与语气词
  t = t.replace(/^(小[王李张刘陈杨赵周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段漕钱汤尹黎易常武乔贺赖龚文][，,、\s])/, '');
  t = t.replace(/(在吗|睡了吗|有个事|跟你说一下|这样)[，,、？?\s]*/g, '');
  t = t.replace(/^(顺便|另外|还有|再帮我|帮我)/, '');
  // 截取到第一个句号/问号前, 控制长度
  let first = t.split(/[。！!？?]/)[0];
  // 剥掉截止时间表达和收尾的"给我/发我", 只留任务本体
  const dl = risk.extractDeadline(first);
  if (dl) first = first.replace(dl, '');
  first = first.replace(/(周[一二三四五六日天]|今天|明天|下班前|之前|前)[，,、\s]*$/, '');
  first = first.replace(/[，,、\s]*(给我|发我|交给我|同步我|告诉我)$/, '');
  first = first.replace(/[，,、\s]*(急|加急)$/, '');
  first = first.replace(/^[，,、？?\s]+/, '');
  first = first.replace(/[，,、\s]+$/, '');
  const task = (first || t).slice(0, 48);
  return task || '对方布置的事项';
}

function extractCommitment(text, scenario) {
  const deadlineText = risk.extractDeadline(text);
  const hasTask = ['added_work', 'chasing', 'confirm_task', 'bad_news'].includes(scenario);
  if (!hasTask && scenario !== 'after_hours') {
    return { task: null, deadlineText, needsConfirm: false };
  }
  const task = extractTask(text);
  return {
    task,
    deadlineText,
    // 没有明确时间点的新任务必须反问确认, 这是防背锅的核心动作
    needsConfirm: !deadlineText,
  };
}

// ---------- 潜台词翻译 ----------
function decodeSubtext(text, scenario, relation) {
  const deadline = risk.extractDeadline(text);
  const who = relation || '对方';
  switch (scenario) {
    case 'criticism':
      return {
        line: `${who}真正问的不是"为什么错", 而是"下次还靠不靠得住"——先给补救动作和时间点, 解释放后面`,
        evidence: matchEvidence(text, /(怎么还没|为什么|失望|注意一下|又错|太慢了|不满意|粗心|返工)/),
      };
    case 'added_work':
      return {
        line: deadline
          ? `${who}在给你加一件新活, 而且心里已经默认了时间点: ${deadline}。先确认优先级再接, 别默认你手头的事可以让路`
          : `${who}在给你加一件新活, 但没说时间点和优先级——这是最容易背锅的派活方式, 必须反问确认`,
        evidence: matchEvidence(text, /(顺便|另外|再帮|再做|加一个|新需求|你来负责|安排给你|帮忙做|抽空把)/),
      };
    case 'chasing':
      return {
        line: `${who}要的不是细节, 是一个能拿去交差的时间点。给"已完成X + 卡在Y + 几点给结果"三件套就够了`,
        evidence: matchEvidence(text, /(进度|到哪一步|怎么样了|好了没|什么时候能|何时能|催一下|等着用)/),
      };
    case 'bad_news':
      return {
        line: `坏消息要抢在${who}发现之前说: 先报影响和补救方案, 再报原因。等被问出来, 性质就从"汇报"变成"隐瞒"`,
        evidence: matchEvidence(text, /(延期|做不完|来不及|出了问题|卡住|风险|故障|报错)/),
      };
    case 'after_hours':
      return {
        line: `${who}多半不是要你现在就干完, 是怕明天忘/怕你没看到。回一个"收到+明天几点处理"就能关掉这个对话框, 不用现在开工`,
        evidence: matchEvidence(text, /(在吗|睡了吗|明天|周一|上班|先看|先处理|急)/),
      };
    default:
      return {
        line: `${who}在等你确认"听懂了+什么时候给"。只回"收到"不算确认, 要复述任务和时间点`,
        evidence: deadline ? `文中出现时间点: ${deadline}` : '文中没有明确时间点, 需要反问',
      };
  }
}

function matchEvidence(text, re) {
  const m = (text || '').match(re);
  return m ? `原文依据: 「${m[0]}」` : '依据: 语境与发送关系推断';
}

// ---------- 话术生成: 3 个版本, 语气梯度明确 ----------
function buildReplies(scenario, ctx) {
  const { relation, intent, commitment } = ctx;
  const dl = commitment.deadlineText;
  const dlText = dl ? dl : '今天下班前';
  const task = commitment.task || '这件事';

  const byScenario = {
    criticism: [
      { label: '稳妥版', text: `收到, 这次确实是我这边没把控好。我先把问题定位清楚, ${dlText}给您一个处理结果和后续的避免办法, 您看这样可以吗?` },
      { label: '不卑不亢版', text: `这个问题我认, 具体出在执行环节, 不是流程本身的问题。我正在改, ${dlText}改完同步您; 也想跟您确认一下, 这类问题以后按哪个标准验收, 避免再返工。` },
      { label: '推进版', text: `我先汇报处理动作: 已经定位到原因, 正在修正, 预计${dlText}完成。修正后我会把检查清单一并发您, 这类问题后面用清单兜底。` },
    ],
    added_work: [
      { label: '稳妥版', text: `收到, 我确认一下: 「${task}」${dl ? `, 时间点是${dl}` : ''}。我手头还有两件在进行的, 我先把这个排进去, ${dl ? dl : '今天'}给您第一版, 排期有冲突我提前跟您说。` },
      { label: '不卑不亢版', text: `可以接。我先对齐一下优先级: 这个和我手头正在做的比, 哪个更靠前? 如果这个优先, 另一件的交付时间会顺延, 您确认的话我就调整顺序。` },
      { label: '推进版', text: `好的, 我先把需求拆一下: 第一步先确认范围和交付标准, 第二步${dlText}出第一版给您看方向, 方向确认后再往下做, 避免做到一半返工。` },
    ],
    chasing: [
      { label: '稳妥版', text: `同步一下进度: 主体已经完成, 还剩收尾部分在处理, 预计${dlText}给您最终版。中途有变化我会提前说, 不会等到最后才汇报。` },
      { label: '不卑不亢版', text: `进度同步: 目前卡在一个依赖环节, 不是停滞, 是在等确认。我先把已完成的部分发您, 剩下的等确认后${dlText}补齐。` },
      { label: '推进版', text: `给您一个明确节点: ${dlText}交最终版。在那之前, 我先把当前版本发您看, 如果方向有问题现在调整成本最低。` },
    ],
    bad_news: [
      { label: '稳妥版', text: `提前跟您同步一个风险: 「${task}」按原时间点交付有困难, 原因是关键环节比预估多了一步。我已经在处理, 新的时间点是${dlText}, 影响范围我整理成一页发您。` },
      { label: '不卑不亢版', text: `汇报一下: 这件事需要延期, 原因在我这边的预估, 不在执行。为了不再二次延期, 我把剩余步骤和每步的时间列出来了, 新节点${dlText}, 请您过目。` },
      { label: '推进版', text: `先给结论: 需要延期到${dlText}。补救方案有两个: 一是先交付核心部分、次要部分随后补; 二是整体延期一次到位。您选哪个, 我按哪个执行。` },
    ],
    after_hours: [
      { label: '稳妥版', text: `收到, 我看到了。明早到工位第一件事就处理, ${dlText}给您结果。今晚先不展开, 避免信息不全反而出错。` },
      { label: '不卑不亢版', text: `收到, 已记录。非紧急的话我明天上班优先处理; 如果今晚就要处理, 您告诉我最晚时间点, 我安排一下。` },
      { label: '推进版', text: `收到。为了明早不耽误, 我先确认两点: 交付标准和最晚时间。您回我之后, 我明早直接开工, ${dlText}交付。` },
    ],
    confirm_task: [
      { label: '稳妥版', text: `收到, 我复述一下确认: 「${task}」${dl ? `, 时间点${dl}` : ', 时间点我再跟您确认'}。理解没偏差的话我就开始, 有问题您随时纠正我。` },
      { label: '不卑不亢版', text: `收到。开始之前确认一个关键点: 交付标准按上次的版本还是有新要求? 标准定了, 我这边就不会返工。` },
      { label: '推进版', text: `收到, 我直接拆成两步: 先出框架给您确认方向, 再补完整内容, 节点分别是${dlText}和最终版, 这样中途不会跑偏。` },
    ],
  };

  let replies = (byScenario[scenario] || byScenario.confirm_task).map((r) => ({ ...r }));

  // intent 微调: 在稳妥版上叠加意图动作 (拒绝/争取时间走替换, 其余追加确认句)
  if (intent === '委婉拒绝' && scenario === 'added_work') {
    replies[1] = {
      label: '不卑不亢版',
      text: '这个我需要先说明一下: 我这周的排期已经满了, 硬接的话两边质量都保不住。可以看看是否能延到下周, 或者换一位同事先顶上关键部分, 我可以做交接支持。',
    };
  }
  if (intent === '争取时间' && scenario !== 'after_hours') {
    replies[0] = {
      label: '稳妥版',
      text: replies[0].text.replace(/预计|给您|交/, (m) => m) + ' 另外想申请把节点放宽半天: 现在硬赶容易出错, 多半天我能把自查一起做完, 整体返工风险更低。',
    };
  }

  // 每条回复过一遍风险自检, 把自检结果写进 riskNote
  return replies.map((r) => {
    const selfRisks = risk.checkReplyRisks(r.text, { hasTask: !!commitment.task });
    return {
      label: r.label,
      text: r.text,
      riskNote: selfRisks.length
        ? `注意: ${selfRisks[0].detail}`
        : '风险自检: 无打包票、无过度道歉、无模糊确认, 可直接发送',
    };
  });
}

// ---------- 反面教材 ----------
const ANTI_EXAMPLES = {
  criticism: { text: '对不起对不起, 都是我的错, 我太笨了, 我马上改, 保证不再犯了', reason: '连环道歉+自贬+空头保证: 责任全揽、问题没说清、还承诺了"不再犯"这种做不到的事' },
  added_work: { text: '没问题, 包在我身上, 周五前肯定给您', reason: '没对齐优先级和范围就打包票, 还钉死了时间点; 做不到时这张截图就是追责证据' },
  chasing: { text: '快了快了, 马上就好', reason: '没有完成度、没有时间点, 对方只会半小时后再催一次, 而且会觉得你在敷衍' },
  bad_news: { text: '那个……可能稍微有点小问题, 应该问题不大吧', reason: '含糊其辞拖延坏消息, 等对方自己发现时, 问题就从"延期"升级成"不诚实"' },
  after_hours: { text: '好的好的, 我现在就起来做, 做完发您', reason: '凌晨秒回+立刻开工, 等于告诉对方"我的休息时间随时可占用", 下次只会更晚找你' },
  confirm_task: { text: '收到', reason: '只回两个字: 没复述任务、没确认时间, 理解错了做错了, 背锅的是你不是派活的人' },
};

/**
 * 主入口
 * @param {{text:string, relation?:string, intent?:string, hour?:number}} input
 */
function analyze(input) {
  if (!input || typeof input.text !== 'string' || !input.text.trim()) {
    throw new Error('input.text 必填: 把对方发来的消息粘进来');
  }
  const text = input.text.trim();
  const relation = RELATIONS.includes(input.relation) ? input.relation : '直属领导';
  const intent = INTENTS.includes(input.intent) ? input.intent : '确认任务';
  const hour = typeof input.hour === 'number' ? input.hour : undefined;

  const scenario = detectScenario(text, intent, hour);
  const commitment = extractCommitment(text, scenario);
  const subtext = decodeSubtext(text, scenario, relation);
  const signals = risk.analyzeIncomingSignals(text);

  // 收到的消息层面的风险提示 (给用户看的)
  const risks = [];
  if (commitment.needsConfirm) {
    risks.push({ type: 'no_deadline', level: 'high', detail: '对方没给明确时间点: 不反问确认, 默认就是"越快越好", 最后按对方心里的期限追责你' });
  }
  if (scenario === 'criticism') {
    risks.push({ type: 'emotion_first', level: 'medium', detail: '对方情绪在前: 先回处理动作, 不要在第一句就解释原因, 解释会被读成辩解' });
  }
  if (scenario === 'after_hours') {
    risks.push({ type: 'boundary', level: 'medium', detail: '休息时间秒回并立刻开工会抬高对方预期; 确认收到+给出明天的时间点, 边界和响应都有了' });
  }
  for (const s of signals) {
    risks.push({ type: s.type, level: 'medium', detail: s.detail });
  }

  const replies = buildReplies(scenario, { relation, intent, commitment });
  const anti = ANTI_EXAMPLES[scenario];

  return {
    scenario,
    scenarioName: SCENARIO_NAMES[scenario],
    relation,
    intent,
    subtext,
    risks,
    commitment,
    replies,
    antiExample: { text: anti.text, reason: anti.reason },
  };
}

module.exports = { analyze, detectScenario, extractCommitment, RELATIONS, INTENTS, SCENARIO_NAMES };
