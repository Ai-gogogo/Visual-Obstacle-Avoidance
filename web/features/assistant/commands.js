export function matchVoiceCommand(text) {
  const phrase = text.normalize('NFKC').toLowerCase().trim().replace(/[.!?。！？]+$/u,'');
  const chinese = phrase.replace(/[\s,，]/gu,'').replace(/^(?:请|請|帮我|幫我)/u,'');
  if (/^(?:确认(?:保存|登记|删除|修改)?|确定|同意|可以保存|保存吧|是的|confirm(?: and save| deletion)?|yes|go ahead)$/iu.test(chinese) ||
      /^(?:confirm and save|go ahead)$/iu.test(phrase)) return {kind:'confirm',value:true};
  if (/^(?:取消(?:保存|登记|删除|修改)?|不用保存|不要保存|不保存|cancel(?: saving| registration| deletion)?|no)$/iu.test(phrase)) return {kind:'confirm',value:false};
  if (/^(?:发送(?:这段|这条)?转写|提交转写|确认发送|send (?:the )?transcript)$/iu.test(phrase)) return {kind:'sendReview'};
  if (/^(?:丢弃(?:这段|这条)?转写|取消转写|重新说|discard (?:the )?transcript)$/iu.test(phrase)) return {kind:'discardReview'};
  if (/^(?:再(?:读|念|播|说)一遍|重播(?:上一条)?|朗读(?:上一条|回答)|read (?:that|the answer) aloud|repeat (?:the |your |last )?answer)$/iu.test(chinese) ||
      /^(?:read (?:that|the answer) aloud|repeat (?:the |your |last )?answer)$/iu.test(phrase)) return {kind:'replay'};
  if (/^(?:停止播报|停止朗读|别播了|stop (?:reading|playback|speaking))$/iu.test(phrase)) return {kind:'stopPlayback'};
  const pair = /^(?:(?:给)?(?:相机)?([ab]|左边|右边)(?:相机)?(?:生成)?配对码|(?:配对|连接)(?:手机|相机)([ab])|(?:生成|读出)(?:相机)?([ab]|左边|右边)(?:相机)?的?配对码)$/iu.exec(chinese) ||
    /^(?:pair (?:phone|camera)|(?:generate|read) (?:the )?pairing code for camera)\s+([ab])$/iu.exec(phrase);
  if (pair) return {kind:'pair',value:/^(a|左)/iu.test(pair.find((value,index) => index>0 && value)) ? 'A' : 'B'};
  if (/^(?:配对(?:一个)?(?:手机|相机)|打开配对|pair (?:a )?(?:phone|camera))$/iu.test(chinese) ||
      /^pair (?:a )?(?:phone|camera)$/iu.test(phrase)) return {kind:'pair'};
  if (/^(?:关闭配对(?:窗口)?|close pairing)$/iu.test(phrase)) return {kind:'closePair'};
  if (/^(?:复制配对码|copy (?:the )?pairing code)$/iu.test(phrase)) return {kind:'copyPair'};
  if (/^(?:再读一遍配对码|重读配对码|repeat (?:the )?pairing code)$/iu.test(phrase)) return {kind:'readPair'};
  const usb = /^(?:(应用|连接|刷新|断开)(?:usb|有线)(?:相机|设备)?|(?:usb|有线)(?:相机)?(?:改为|设为)(1080|480))$/iu.exec(chinese);
  if (usb) return {kind:'usb',value:usb[2] || {应用:'connect',连接:'connect',刷新:'refresh',断开:'disconnect'}[usb[1]]};
  const usbSlot = /^(?:把)?(?:usb|有线)相机([ab])(?:设为|选|选择)(?:第)?([1-9一二三四五六七八九])(?:个)?$/iu.exec(chinese);
  if (usbSlot) return {kind:'usbSlot',side:usbSlot[1].toUpperCase(),value:Number(usbSlot[2]) || '零一二三四五六七八九'.indexOf(usbSlot[2])};
  if (/^(?:回答(?:简短点|短一点)|简单回答|用简短回答|short(?:er)? replies)$/iu.test(phrase)) return {kind:'preference',field:'concise',value:true};
  if (/^(?:回答(?:详细点|详细一点)|详细回答|用详细回答|more detailed replies)$/iu.test(phrase)) return {kind:'preference',field:'concise',value:false};
  if (/^(?:关闭(?:习惯)?提醒|取消(?:习惯)?提醒|turn off reminders)$/iu.test(phrase)) return {kind:'preference',field:'habit',value:null};
  const reminder = /^(?:相机(?:上线|连上)(?:时|后)?提醒我|(?:开启|设置)提醒[：:\s]+|remind me when (?:the )?camera connects[:\s]+)(.+)$/iu.exec(phrase);
  if (reminder) return {kind:'preference',field:'habit',value:reminder[1].trim()};
  const interval = /^(?:提醒间隔(?:设为|改成)?|(?:相机)?提醒(?:每隔|每))(?:(15|60|1440)分钟|(1|24)小时|(每次连接|每次上线))$/u.exec(chinese);
  if (interval) return {kind:'preference',field:'interval_minutes',value:interval[3] ? 0 : interval[2] ? Number(interval[2])*60 : Number(interval[1])};
  const spokenInterval = /^(?:提醒间隔(?:设为|改成)?|(?:相机)?提醒(?:每隔|每))(?:(十五分钟|一小时|二十四小时|一天))$/u.exec(chinese);
  if (spokenInterval) return {kind:'preference',field:'interval_minutes',value:{十五分钟:15,一小时:60,二十四小时:1440,一天:1440}[spokenInterval[1]]};
  if (/^(?:保存(?:当前)?(?:设置|偏好)|save preferences)$/iu.test(phrase)) return {kind:'savePreferences'};
  const panels = /^(打开|展开|关闭|收起)(键盘|文字输入|语音设置|语音控制|记忆面板|已保存记忆|(?:回答和)?提醒设置|偏好设置)$/u.exec(chinese);
  if (panels) return {kind:'panel',open:/打开|展开/u.test(panels[1]),value:
    /键盘|文字/u.test(panels[2]) ? 'keyboard-input' : /语音/u.test(panels[2]) ? 'voice-settings' :
      /记忆/u.test(panels[2]) ? 'memory-panel' : 'preferences-panel'};
  const wake = /^(开启|打开|启用|关闭|禁用)(?:免提(?:唤醒)?|唤醒词)$/u.exec(chinese);
  if (wake) return {kind:'wakeSetting',value:/开启|打开|启用/u.test(wake[1])};
  const motion = /^(开启|打开|关闭|取消)(?:减少动画|减少动态效果)$/u.exec(chinese);
  if (motion) return {kind:'motion',value:/开启|打开/u.test(motion[1])};
  if (/^(?:我能说什么|语音命令|语音帮助|voice commands)$/iu.test(phrase)) return {kind:'help'};
  const camera = /^(?:只(?:看|用|开)|(?:(?:把)?(?:相机|相機|摄像头))?(?:切换|切換|切|换|換|调|調|改|设)(?:为|成|到)?)(?:只(?:看|用))?(左(?:边|邊|侧|側)?|右(?:边|邊|侧|側)?|a|b)(?:的)?(?:相机|相機|摄像头|画面|畫面)?$/iu.exec(chinese);
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
