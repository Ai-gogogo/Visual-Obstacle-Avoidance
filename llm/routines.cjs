const PLAN_FORMAT = {
  type:'object',
  required:['steps'],
  properties:{steps:{type:'array',maxItems:6,items:{type:'string',maxLength:160}}}
};

function routineStatement(text) {
  const statement = text.replace(/[.!。！]+$/u,'');
  if (/[?？]$/u.test(statement)) return null;
  const english = /^I\s+(?:usually|always|typically)\s+(.+)$/iu.exec(statement);
  if (english) return 'I usually ' + english[1];
  if (/^我(?:通常|总是|總是|每次|每天|一般都会).{2,}$/u.test(statement) ||
      /^出[门門]前我(?:通常|都[会會]?|一般[都會会]*).{2,}$/u.test(statement)) return statement;
  return null;
}

function routineObservation(text) {
  const statement = text.replace(/[.!。！]+$/u,'');
  const chinese = /^我(?:今天|刚才)出[门門]前[，,\s]*(.{2,})$/u.exec(statement);
  const english = /^(?:today[,\s]+)?before (?:leaving|going out)[,\s]+i\s+(.+)$/iu.exec(statement);
  if (/[?？]$/u.test(statement)) return null;
  if (chinese) return '出门前：' + chinese[1];
  return english ? 'Before leaving: I ' + english[1] : null;
}

function parsePlan(reply) {
  const {steps} = JSON.parse(reply);
  if (!Array.isArray(steps) || steps.length > 6 || !steps.every(step =>
    typeof step === 'string' && step.trim().length > 0 && step.length <= 160)) {
    throw new Error('Invalid plan.');
  }
  return steps.map(step => step.trim());
}

function planStep(plan) {
  const {index, steps, chinese} = plan;
  const n = index + 1;
  return chinese ? '第 ' + n + ' 步（共 ' + steps.length + ' 步）：' + steps[index] :
    'Step ' + n + ' of ' + steps.length + ': ' + steps[index];
}

module.exports = {PLAN_FORMAT,routineStatement,routineObservation,parsePlan,planStep};
