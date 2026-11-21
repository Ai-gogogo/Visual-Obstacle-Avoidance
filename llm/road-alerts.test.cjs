const test = require('node:test');
const assert = require('node:assert/strict');
const {acceptRoadEdge} = require('./road-alerts.cjs');

test('only one caution after two close frames, with hysteresis and rearm', () => {
  const slot = {detection:{}};
  const observe = (level, t, distance_m) => acceptRoadEdge(slot,{level,distance_m,point:[.5,.6]},t,'B',true);
  assert.equal(observe('clear',100,5),undefined);
  assert.equal(observe('clear',300,4.8),undefined);
  assert.equal(observe('hold',500,3.6),undefined);
  assert.equal(observe('caution',700,3.5),undefined);
  const first = observe('caution',900,3.5);
  assert.equal(first.risk,'caution');
  assert.equal(first.text,'Caution. Road edge about 3.5 meters ahead.');
  assert.equal(first.text_zh,'小心，前方约3.5米是车行道边缘。');
  assert.equal(observe('urgent',1100,3),undefined);
  assert.equal(observe('urgent',1300,2.8),undefined);
  assert.equal(observe('hold',1500,4),undefined);
  assert.equal(observe('caution',1700,3.4),undefined);
  observe('clear',2000,4.2);
  observe('clear',3100,4.2);
  assert.equal(observe('caution',3200,3.4),undefined);
  assert.equal(observe('urgent',3500,2.8).risk,'caution'); // Legacy input is still an ordinary notice.
});

test('gaps, source changes, an invalid pair and qualitative-only evidence', () => {
  const slot = {detection:{}};
  const road = {level:'caution',distance_m:2.3,point:[.5,.6]};
  assert.equal(acceptRoadEdge(slot,road,100,'b1',true),undefined);
  assert.equal(acceptRoadEdge(slot,road,1600,'b1',true),undefined);
  assert.equal(acceptRoadEdge(slot,road,1800,'b2',true),undefined);
  assert.equal(acceptRoadEdge(slot,road,2000,'b2',false),undefined);
  assert.equal(acceptRoadEdge(slot,road,2200,'b2',true),undefined);
  const visual = {level:'visual',point:[.5,.6]};
  assert.equal(acceptRoadEdge(slot,visual,2400,'b2',false),undefined);
  assert.doesNotMatch(acceptRoadEdge(slot,visual,2600,'b2',false).text_zh,/米/);
  assert.equal(acceptRoadEdge(slot,visual,2800,'b2',false),undefined);
  assert.equal(acceptRoadEdge(slot,road,3000,'b2',true),undefined);
  assert.equal(acceptRoadEdge(slot,road,3200,'b2',true),undefined);
});
