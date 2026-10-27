import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceTime,editedTime,cutRanges,parseTime,timeInput,dragRegion,editTimeline,splitTimeline,snapTime,duration,nearestPoint } from '../model.js';

test('preview skips removed frames at a cut and maps back to the edited ruler',()=>{
  const project={keep:cutRanges([{start_us:0,end_us:10_000_000}],2_000_000,5_000_000)};
  assert.equal(sourceTime(project,2_000_000),5_000_000);
  assert.equal(editedTime(project,6_000_000),3_000_000);
  assert.equal(editedTime(project,3_000_000),2_000_000);
  assert.throws(()=>cutRanges(project.keep,0,10_000_000));
});
test('numeric time does not lose sub-frame precision or accept non-finite input',()=>{
  assert.equal(parseTime('123,000007'),123_000_007);
  assert.equal(parseTime(timeInput(8_666_667)),8_666_667);
  assert.equal(parseTime(timeInput(33_333)),33_333);
  assert.throws(()=>parseTime('NaN'));assert.throws(()=>parseTime('1e6'));
});
test('resizing and moving a selection cannot escape a screen or invert the handles',()=>{
  const rect={x:100,y:100,width:640,height:360};
  assert.deepEqual(dragRegion(rect,'move',-200,1000,1920,1080),{x:0,y:720,width:640,height:360});
  assert.deepEqual(dragRegion(rect,'nw',1000,1000,1920,1080),{x:738,y:458,width:2,height:2});
});
test('edited selection spans cuts without deleting excluded source gaps twice',()=>{
  const keep=[{start_us:0,end_us:2_000_000},{start_us:5_000_000,end_us:8_000_000}];
  assert.deepEqual(editTimeline(keep,1_000_000,3_000_000),[{start_us:0,end_us:1_000_000},{start_us:6_000_000,end_us:8_000_000}]);
  assert.deepEqual(editTimeline(keep,1_000_000,3_000_000,true),[{start_us:1_000_000,end_us:2_000_000},{start_us:5_000_000,end_us:6_000_000}]);
  assert.equal(duration({keep:editTimeline(keep,1_000_000,3_000_000)}),3_000_000);
  assert.throws(()=>editTimeline(keep,0,5_000_000));
  assert.throws(()=>editTimeline(keep,0,6_000_000,true));
  assert.throws(()=>editTimeline(keep,NaN,1_000_000));
  assert.deepEqual(editTimeline(keep,2_000_000,5_000_000),[keep[0]]);
});
test('split preserves source order, length and mapping at every boundary',()=>{
  const keep=[{start_us:0,end_us:1_000_000},{start_us:4_000_000,end_us:7_000_000}];
  const split=splitTimeline(keep,2_000_000);
  assert.deepEqual(split,[keep[0],{start_us:4_000_000,end_us:5_000_000},{start_us:5_000_000,end_us:7_000_000}]);
  assert.equal(duration({keep:split}),duration({keep}));
  for(const at of [0,999_999,1_000_000,1_999_999,2_000_000,3_999_999])assert.equal(sourceTime({keep:split},at),sourceTime({keep},at));
  assert.throws(()=>splitTimeline(keep,1_000_000));assert.throws(()=>splitTimeline(keep,0));
  assert.throws(()=>splitTimeline(keep,4_000_000));
});
test('timeline operations conserve duration for arbitrary disjoint clips',()=>{
  const keep=[{start_us:0,end_us:9},{start_us:20,end_us:31},{start_us:40,end_us:48}];
  const total=duration({keep});
  for(let start=0;start<total;start++)for(let end=start+1;end<=total;end++){
    const retained=editTimeline(keep,start,end,true);
    assert.equal(duration({keep:retained}),end-start);
    if(end-start<total)assert.equal(duration({keep:editTimeline(keep,start,end)}),total-(end-start));
    assert.ok(retained.every((r,i)=>r.start_us<r.end_us && (!i || retained[i-1].end_us<=r.start_us)));
  }
});
test('selection snaps to frames and clamps both ends',()=>{
  assert.equal(snapTime(50_000,30,4_000_000),66_667);
  assert.equal(snapTime(-1_000,60,4_000_000),0);
  assert.equal(snapTime(4_100_000,30,4_000_000),4_000_000);
});

test('magnetic selection uses nearest valid point and leaves distant positions free',()=>{
  const points=[{at:0,label:'start'},{at:2_000_000,label:'cut'},{at:2_020_000,label:'cursor'},{at:4_000_000,label:'end'}];
  assert.equal(nearestPoint(2_018_000,points,25_000,0,4_000_000),points[2]);
  assert.equal(nearestPoint(1_970_000,points,25_000,0,4_000_000),null);
  assert.equal(nearestPoint(2_018_000,points,25_000,0,2_010_000),points[1]);
  assert.equal(nearestPoint(2_018_000,points,25_000,2_030_000,4_000_000),null);
  assert.equal(nearestPoint(2_010_000,points,25_000,0,4_000_000),points[1]);
});
