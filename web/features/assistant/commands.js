export function matchVoiceCommand(text) {
  const phrase = text.normalize('NFKC').toLowerCase().trim().replace(/[.!?。！？]+$/u,'');
  const chinese = phrase.replace(/[\s,，]/gu,'').replace(/^(?:请|請|帮我|幫我)/u,'');
  const camera = /^(?:只(?:看|用|开)|(?:(?:把)?(?:相机|相機|摄像头))?(?:切换|切換|换|換|调|調|改|设)(?:为|成|到)?)(?:只(?:看|用))?(左(?:边|邊|侧|側)?|右(?:边|邊|侧|側)?|a|b)(?:的)?(?:相机|相機|摄像头|画面|畫面)?$/iu.exec(chinese);
  if (camera) return {kind:'camera',value:/^[左a]/iu.test(camera[1]) ? 'A' : 'B'};
  const englishCamera = /^(?:please )?(?:only look|look only|only use|use only|use|switch to) (?:the )?(left|right|camera a|camera b)(?: (?:camera|feed|only))?$/iu.exec(phrase);
  if (englishCamera) return {kind:'camera',value:['left','camera a'].includes(englishCamera[1]) ? 'A' : 'B'};
  if (/^(?:(?:(?:切换|切換|换|換)(?:到|成)?|恢复|恢復|看|用|开启|打开)?(?:双相机|雙相機|双路|雙路|两个相机|兩個相機|两台相机|兩台相機|两路画面|雙畫面)(?:模式)?|两个都看|兩個都看|两边都看|兩邊都看)$/u.test(chinese) ||
      /^(?:please )?(?:use|show|look at|switch to) both (?:cameras|feeds)$/iu.test(phrase)) return {kind:'camera',value:'both'};

  const language = [
    ['zh',/^(?:(?:语音|語音|识别|識別)?语言|語言)?(?:切换|切換|设|改|换|換|用)(?:到|为|成)?(?:普通话|普通話|中文|汉语|漢語)(?:识别|識別)?$/u, /^(?:switch to|use) (?:mandarin(?: chinese)?|chinese)$/iu],
    ['en',/^(?:(?:语音|語音|识别|識別)?语言|語言)?(?:切换|切換|设|改|换|換|用)(?:到|为|成)?(?:英语|英語|英文)(?:识别|識別)?$/u, /^(?:switch to|use) english$/iu],
    ['system',/^(?:(?:语音|語音|识别|識別)?(?:语言|語言))?(?:恢复|恢復|使用|切换到)?(?:跟随|跟隨|跟着)?(?:系统|系統)(?:语言|語言)?$/u, /^(?:follow|use|switch to) (?:the )?system language$/iu],
    ['auto',/^(?:语言|語言)?(?:切换到|改成|开启|使用)?自动(?:识别|检测)(?:语言)?$/u, /^(?:use|enable|switch to) auto(?:matic)? (?:language )?detect(?:ion)?$/iu]
  ].find(([,zh,en]) => zh.test(chinese) || en.test(phrase));
  if (language) return {kind:'language',value:language[0]};

  const toggles = [
    ['review',true,/^(?:开启|打开|啟用|启用)(?:转写|轉寫)(?:确认|確認|审核|審核)$/u,/^(?:enable|turn on) transcription review$/iu],
    ['review',false,/^(?:关闭|關閉|取消)(?:转写|轉寫)(?:确认|確認|审核|審核)$/u,/^(?:disable|turn off) transcription review$/iu],
    ['contrast',true,/^(?:开启|打开|啟用|启用)高对比度$/u,/^(?:enable|turn on) high contrast$/iu],
    ['contrast',false,/^(?:关闭|關閉|取消)高对比度$/u,/^(?:disable|turn off) high contrast$/iu]
  ].find(([, ,zh,en]) => zh.test(chinese) || en.test(phrase));
  if (toggles) return {kind:toggles[0],value:toggles[1]};
  if (/^导出(?:这次|这段|本次)?对话(?:记录)?(?:为word)?$/iu.test(chinese) ||
      /^export (?:the |this )?conversation(?: to word)?$/iu.test(phrase)) return {kind:'export'};
  if (/^(?:结束|結束|停止)(?:这次|這次|语音|語音)?(?:对话|對話)$/u.test(chinese) ||
      /^(?:end|stop) (?:this |the )?(?:voice )?conversation$/iu.test(phrase)) return {kind:'stop'};
  return null;
}

export function wakeCommand(transcript) {
  const phrase = /^(?:(?:hey|hi|hello)[,\s]+vision\s*assist\b|(?:你好|您好)[，,\s]*(?:视觉助手|視覺助手|vision\s*assist\b))/iu;
  const text = transcript.trim();
  const match = phrase.exec(text);
  return match ? text.slice(match[0].length).replace(/^[\s,.!?:，。！？：]+/u,'') : null;
}
