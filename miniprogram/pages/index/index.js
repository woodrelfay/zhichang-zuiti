// pages/index/index.js — 输入消息 -> 潜台词/风险/承诺/三版回复
const { analyze, RELATIONS, INTENTS } = require('../../utils/engine');

Page({
  data: {
    text: '',
    relations: RELATIONS,
    intents: INTENTS,
    relationIndex: 0,
    intentIndex: 4, // 默认: 确认任务
    result: null,
    error: '',
  },
  onTextInput(e) { this.setData({ text: e.detail.value }); },
  onRelationChange(e) { this.setData({ relationIndex: Number(e.detail.value) }); },
  onIntentChange(e) { this.setData({ intentIndex: Number(e.detail.value) }); },
  onAnalyze() {
    const { text, relations, intents, relationIndex, intentIndex } = this.data;
    if (!text.trim()) { this.setData({ error: '先把对方发来的消息粘进来' }); return; }
    try {
      const result = analyze({
        text,
        relation: relations[relationIndex],
        intent: intents[intentIndex],
        hour: new Date().getHours(),
      });
      this.setData({ result, error: '' });
    } catch (err) {
      this.setData({ error: err.message, result: null });
    }
  },
  onCopy(e) {
    wx.setClipboardData({
      data: e.currentTarget.dataset.text,
      success: () => wx.showToast({ title: '已复制, 粘贴就能发', icon: 'success' }),
    });
  },
});
