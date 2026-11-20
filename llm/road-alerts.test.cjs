const test = require('node:test');
const assert = require('node:assert/strict');
const {acceptRoadEdge} = require('./road-alerts.cjs');

test('two-frame confirmation, escalation, hysteresis, and a new approach', () => {
  const slot = {detection:{}};
  const observe = (level, t) => acceptRoadEdge(slot,{level,distance_m:level === 'urgent' ? 2.8 : 4.8,
    point:[.5,.6]},t,'B',true);
  assert.equal(observe('caution',100),undefined);
  assert.equal(observe('urgent',300).risk,'caution');
  assert.equal(observe('urgent',500).risk,'urgent');
  for (const [i, level] of ['hold','caution','urgent','urgent','unseen','caution'].entries()) {
    assert.equal(observe(level,700+i*200),undefined);
  }
  observe('clear',2000);
  observe('clear',3100);
  assert.equal(observe('caution',3200),undefined);
  assert.match(observe('caution',3500).text_zh,/4.8米/);
});

test('gaps, source changes, an invalid pair and qualitative-only evidence', () => {
  const slot = {detection:{}};
  const road = {level:'urgent',distance_m:2.3,point:[.5,.6]};
  assert.equal(acceptRoadEdge(slot,road,100,'b1',true),undefined);
  assert.equal(acceptRoadEdge(slot,road,1600,'b1',true),undefined);
  assert.equal(acceptRoadEdge(slot,road,1800,'b2',true),undefined);
  assert.equal(acceptRoadEdge(slot,road,2000,'b2',false),undefined);
  assert.equal(acceptRoadEdge(slot,road,2200,'b2',true),undefined);
  const visual = {level:'visual',point:[.5,.6]};
  assert.equal(acceptRoadEdge(slot,visual,2400,'b2',false),undefined);
  assert.doesNotMatch(acceptRoadEdge(slot,visual,2600,'b2',false).text_zh,/米/);
  assert.equal(acceptRoadEdge(slot,visual,2800,'b2',false),undefined);
});
