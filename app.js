// 法语单词背诵应用主逻辑

// UTF-8 字符串转 Base64（支持法语特殊字符如 é、è、ç 等）
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

class FrenchVocabularyApp {
  constructor() {
    this.allWords = flattenVocabulary();
    this.currentWords = [];
    this.currentIndex = 0;
    this.isFlipped = false;

    // 性能优化：按分组预建索引，避免每次切换分组扫描 4657 词
    this.groupIndex = this.buildGroupIndex();

    // 性能优化：计数器代替 updateProgress 中的 3 轮全量 filter
    this.progressCounters = { remembered: 0, strengthen: 0, unlearned: this.allWords.length };

    // 祝贺弹窗：已弹过的分组不再重复
    this.congratulatedGroups = new Set();

    // 语音合成降级：Android/鸿蒙无法语语音时用 Google TTS 音频
    this.audioPlayer = null;
    this.isPronouncing = false;
    this.useAudioFallback = false;

    // 选为"全部词汇"的默认视图
    this.currentWords = [...this.allWords];

    this.initElements();
    this.initEventListeners();
    this.updateDisplay();
    this.renderProgress();
  }

  // 预建分组索引：Map<groupName, Word[]>
  buildGroupIndex() {
    const index = new Map();
    for (const word of this.allWords) {
      if (!index.has(word.group)) {
        index.set(word.group, []);
      }
      index.get(word.group).push(word);
    }
    return index;
  }

  initElements() {
    this.flashcard = document.getElementById('flashcard');
    this.wordGroup = document.getElementById('wordGroup');
    this.wordFrench = document.getElementById('wordFrench');
    this.wordPhonetic = document.getElementById('wordPhonetic');
    this.wordChinese = document.getElementById('wordChinese');
    this.wordFrenchBack = document.getElementById('wordFrenchBack');
    this.collocationsList = document.getElementById('collocationsList');
    this.pronounceBtn = document.getElementById('pronounceBtn');
    this.strengthenBtn = document.getElementById('strengthenBtn');
    this.rememberedBtn = document.getElementById('rememberedBtn');
    this.prevBtn = document.getElementById('prevBtn');
    this.nextBtn = document.getElementById('nextBtn');
    this.groupSelect = document.getElementById('groupSelect');
    this.rememberedCountSpan = document.getElementById('rememberedCount');
    this.strengthenCountSpan = document.getElementById('strengthenCount');
    this.unlearnedCountSpan = document.getElementById('unlearnedCount');

    // 祝贺弹窗元素
    this.congratsOverlay = document.getElementById('congratsOverlay');
    this.congratsDismiss = document.getElementById('congratsDismiss');
  }

  initEventListeners() {
    // 卡片翻转
    this.flashcard.addEventListener('click', () => this.flipCard());

    // 发音按钮
    this.pronounceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pronounce();
    });

    // 反馈按钮
    this.strengthenBtn.addEventListener('click', () => this.markStrengthen());
    this.rememberedBtn.addEventListener('click', () => this.markRemembered());

    // 导航按钮
    this.prevBtn.addEventListener('click', () => this.prevWord());
    this.nextBtn.addEventListener('click', () => this.nextWord());

    // 分组选择
    this.groupSelect.addEventListener('change', () => this.filterByGroup());

    // 祝贺弹窗关闭
    this.congratsDismiss.addEventListener('click', () => this.hideCongrats());
    this.congratsOverlay.addEventListener('click', (e) => {
      if (e.target === this.congratsOverlay) this.hideCongrats();
    });
  }

  flipCard() {
    this.isFlipped = !this.isFlipped;
    if (this.isFlipped) {
      this.flashcard.classList.add('flipped');
    } else {
      this.flashcard.classList.remove('flipped');
    }
  }

  pronounce() {
    const word = this.currentWords[this.currentIndex];
    if (!word || this.isPronouncing) return;

    // 阴阳性单词：将 "acteur,trice" 展开为 "acteur, actrice"
    const pronounceText = word.french.includes(',') ? getPronounceText(word.french) : word.french;

    // 优先尝试 Web Speech API（桌面浏览器）
    if (!this.useAudioFallback && this.hasFrenchVoice()) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(pronounceText);
      utterance.lang = 'fr-FR';
      utterance.rate = 0.8;
      const voices = window.speechSynthesis.getVoices();
      const frenchVoice = voices.find(v => v.lang.startsWith('fr'));
      if (frenchVoice) utterance.voice = frenchVoice;

      // 按钮短暂反馈，让用户知道正在发音
      this.isPronouncing = true;
      this.pronounceBtn.textContent = '🔊 发音中...';
      this.pronounceBtn.disabled = true;

      utterance.onend = () => {
        this.isPronouncing = false;
        this.pronounceBtn.textContent = '🔊 发音';
        this.pronounceBtn.disabled = false;
      };
      utterance.onerror = () => {
        this.isPronouncing = false;
        this.pronounceBtn.textContent = '🔊 发音';
        this.pronounceBtn.disabled = false;
      };

      window.speechSynthesis.speak(utterance);
      return;
    }

    // 降级方案：Google Translate TTS 音频（安卓/鸿蒙均可用）
    this.pronounceViaAudio(pronounceText);
  }

  // 检测是否有法语语音（非空且含 fr-FR 或 fr 开头的语音）
  hasFrenchVoice() {
    if (!('speechSynthesis' in window)) return false;
    const voices = window.speechSynthesis.getVoices();
    return voices.length > 0 && voices.some(v => v.lang.startsWith('fr'));
  }

  // TTS 降级播放：法语助手 API（国内可用，真人发音）
  pronounceViaAudio(text) {
    this.isPronouncing = true;
    this.pronounceBtn.textContent = '🔊 发音中...';
    this.pronounceBtn.disabled = true;

    // 每次创建新 Audio 对象，避免复用导致事件丢失
    if (this.audioPlayer) {
      this.audioPlayer.pause();
      this.audioPlayer.removeAttribute('src');
      this.audioPlayer = null;
    }
    this.audioPlayer = new Audio();

    const safeReset = () => {
      if (!this.isPronouncing) return;
      this.isPronouncing = false;
      this.pronounceBtn.textContent = '🔊 发音';
      this.pronounceBtn.disabled = false;
      if (this.pronounceTimeout) {
        clearTimeout(this.pronounceTimeout);
        this.pronounceTimeout = null;
      }
    };

    // 超时兜底：8 秒后强制恢复按钮
    this.pronounceTimeout = setTimeout(() => {
      safeReset();
    }, 8000);

    this.audioPlayer.onended = safeReset;
    this.audioPlayer.onerror = () => {
      safeReset();
    };
    this.audioPlayer.onabort = safeReset;

    // 法语助手 TTS API（真人发音、国内直连、无需 Key）
    // langid=fr 表示法语（法语助手网站 body class="fr" 对应 fr，不是数字 3）
    const base64 = utf8ToBase64(text);
    this.audioPlayer.src = 'https://api.frdic.com/api/v2/speech/speakweb?langid=fr&txt=QYN' + base64;
    this.audioPlayer.load();
    this.audioPlayer.play().catch(() => {
      safeReset();
    });
  }

  markStrengthen() {
    const word = this.currentWords[this.currentIndex];
    if (!word) return;

    // 更新计数器
    if (word.strengthen === 0 && word.remembered > 0) {
      // 同一个词两种标记都可能，只按照首次标记计数
    }
    if (word.strengthen === 0) {
      this.progressCounters.strengthen++;
    }
    const wasUnlearned = word.totalShown === 0;

    word.strengthen++;
    word.totalShown++;

    if (wasUnlearned) {
      this.progressCounters.unlearned = Math.max(0, this.progressCounters.unlearned - 1);
    }

    this.renderProgress();
    this.nextWord();
  }

  markRemembered() {
    const word = this.currentWords[this.currentIndex];
    if (!word) return;

    if (word.remembered === 0) {
      this.progressCounters.remembered++;
    }
    const wasUnlearned = word.totalShown === 0;

    word.remembered++;
    word.totalShown++;

    if (wasUnlearned) {
      this.progressCounters.unlearned = Math.max(0, this.progressCounters.unlearned - 1);
    }

    this.renderProgress();
    this.checkGroupComplete();
    this.nextWord();
  }

  prevWord() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.isFlipped = false;
      this.flashcard.classList.remove('flipped');
      this.updateDisplay();
    }
  }

  nextWord() {
    this.selectNextWordByAlgorithm();
    this.isFlipped = false;
    this.flashcard.classList.remove('flipped');
    this.updateDisplay();
  }

  selectNextWordByAlgorithm() {
    // 记忆算法：已记住降频、需加强提频
    // 权重 = max(1, 10 - remembered) × (1 + strengthen × 2)
    const len = this.currentWords.length;
    if (len === 0) return;
    if (len === 1) { this.currentIndex = 0; return; }

    // 性能：使用 for 循环代替 map + reduce，单次遍历完成
    let totalWeight = 0;
    const weights = new Float64Array(len);

    for (let i = 0; i < len; i++) {
      const w = this.currentWords[i];
      const rw = Math.max(1, 10 - w.remembered);
      const sw = 1 + w.strengthen * 2;
      const weight = rw * sw;
      weights[i] = weight;
      totalWeight += weight;
    }

    let random = Math.random() * totalWeight;
    for (let i = 0; i < len; i++) {
      random -= weights[i];
      if (random <= 0) {
        this.currentIndex = i;
        return;
      }
    }

    this.currentIndex = Math.floor(Math.random() * len);
  }

  filterByGroup() {
    const group = this.groupSelect.value;

    if (group === 'all') {
      this.currentWords = [...this.allWords];
    } else {
      // 性能优化：从预建索引取，避免每次过滤 4657 词
      this.currentWords = this.groupIndex.get(group) || [];
    }

    this.currentIndex = 0;
    this.isFlipped = false;
    this.flashcard.classList.remove('flipped');
    this.updateDisplay();
    this.renderProgress();
  }

  updateDisplay() {
    if (this.currentWords.length === 0) {
      this.wordGroup.textContent = '—';
      this.wordFrench.textContent = '暂无词汇';
      this.wordPhonetic.textContent = '';
      this.wordChinese.textContent = '请选择其他分组';
      this.wordFrenchBack.textContent = '';
      this.collocationsList.innerHTML = '';
      return;
    }

    const word = this.currentWords[this.currentIndex];
    if (!word) return;

    this.wordGroup.textContent = this.groupSelect.value === 'all' ? '全部词汇' : word.group;
    this.wordFrench.textContent = word.french;
    this.wordPhonetic.textContent = word.phonetic;
    this.wordChinese.textContent = word.chinese;
    // 卡片背面显示完整阴阳形式，如 "acteur, actrice"
    const displayFrench = word.french.includes(',') ? getPronounceText(word.french) : word.french;
    this.wordFrenchBack.textContent = displayFrench;

    this.renderCollocations(word.collocations);
  }

  renderCollocations(collocations) {
    if (!collocations || collocations.length === 0) {
      this.collocationsList.innerHTML = '<div class="collocation-item">暂无固定搭配</div>';
      return;
    }
    this.collocationsList.innerHTML = collocations.map(c => {
      const idx = c.indexOf(' ');
      if (idx > 0) {
        const fr = c.substring(0, idx);
        const zh = c.substring(idx + 1);
        return `<div class="collocation-item">${fr} <span class="collocation-zh">${zh}</span></div>`;
      }
      return `<div class="collocation-item">${c}</div>`;
    }).join('');
  }

  // 判断一个单词是否已"真正记住"：
  //   - 从未标记"需加强"的词：remembered > 0
  //   - 标记过"需加强"的词：需要累计点击"已记住" 3 次才算真正记住
  isMastered(word) {
    if (word.strengthen === 0) {
      // 普通词：点一次"已记住"即可
      return word.remembered > 0;
    } else {
      // 需加强词：需点满 3 次"已记住"才算掌握
      return word.remembered >= 3;
    }
  }

  renderProgress() {
    // 基于当前分组（currentWords）实时统计，切换分组时自然同步
    // 规则：
    //   已记住 = isMastered(w) 为 true 的单词
    //   需加强 = 标记过"需加强"且尚未 isMastered 的单词
    //   未学习 = totalShown === 0 的单词
    let remembered = 0, strengthen = 0, unlearned = 0;
    for (const w of this.currentWords) {
      if (this.isMastered(w)) {
        remembered++;
      } else if (w.strengthen > 0) {
        strengthen++;
      }
      if (w.totalShown === 0) unlearned++;
    }
    this.rememberedCountSpan.textContent = remembered;
    this.strengthenCountSpan.textContent = strengthen;
    this.unlearnedCountSpan.textContent = unlearned;
  }

  // 检查当前分组"已记住"数量是否等于分组词汇总数
  checkGroupComplete() {
    const group = this.groupSelect.value;
    // 只在选中具体分组时弹出，"全部词汇"不弹
    if (group === 'all') return;
    // 每组只弹一次
    if (this.congratulatedGroups.has(group)) return;

    // 获取该分组所有单词
    const groupWords = this.groupIndex.get(group);
    if (!groupWords || groupWords.length === 0) return;

    // 触发条件：当前分组中 isMastered 的词数 = 分组总词数
    const masteredCount = groupWords.filter(w => this.isMastered(w)).length;
    if (masteredCount === groupWords.length) {
      this.congratulatedGroups.add(group);
      // 稍微延迟弹出，让用户先看到最后一个单词翻面
      setTimeout(() => this.showCongrats(), 400);
    }
  }

  showCongrats() {
    this.congratsOverlay.classList.add('active');
  }

  hideCongrats() {
    this.congratsOverlay.classList.remove('active');
  }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
  let app;

  if ('speechSynthesis' in window) {
    // 监听语音列表加载完成
    window.speechSynthesis.onvoiceschanged = () => {
      const voices = window.speechSynthesis.getVoices();
      // 没有法语语音则启用音频降级
      if (!voices.some(v => v.lang.startsWith('fr'))) {
        app.useAudioFallback = true;
      }
    };
    // 如果 voices 已同步加载（Firefox 等），直接判断
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0 && !voices.some(v => v.lang.startsWith('fr'))) {
      // app 还没创建，先标记，创建后再设置
    }
  }

  app = new FrenchVocabularyApp();

  // 再次检查法语语音
  if (!app.hasFrenchVoice()) {
    app.useAudioFallback = true;
  }
});
