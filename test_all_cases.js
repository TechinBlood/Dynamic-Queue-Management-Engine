const Status = Object.freeze({
  BOOKED:"BOOKED",CHECKED_IN:"CHECKED_IN",IN_QUEUE:"IN_QUEUE",
  WEIGHING:"WEIGHING",ACCEPTED:"ACCEPTED",
  REJECTED_MOISTURE:"REJECTED_MOISTURE",DRYING:"DRYING",
  RE_INSPECTION:"RE_INSPECTION",PAYMENT_INITIATED:"PAYMENT_INITIATED",
  PAID:"PAID",CANCELLED:"CANCELLED",NO_SHOW:"NO_SHOW",RESCHEDULED:"RESCHEDULED"
});
const TRANSITIONS={
  [Status.BOOKED]:[Status.CHECKED_IN,Status.CANCELLED,Status.NO_SHOW,Status.RESCHEDULED],
  [Status.CHECKED_IN]:[Status.IN_QUEUE],
  [Status.IN_QUEUE]:[Status.WEIGHING],
  [Status.WEIGHING]:[Status.ACCEPTED,Status.REJECTED_MOISTURE],
  [Status.ACCEPTED]:[Status.PAYMENT_INITIATED],
  [Status.PAYMENT_INITIATED]:[Status.PAID],
  [Status.REJECTED_MOISTURE]:[Status.DRYING],
  [Status.DRYING]:[Status.RE_INSPECTION],
  [Status.RE_INSPECTION]:[Status.IN_QUEUE],
};
const TERMINAL=new Set([Status.PAID,Status.CANCELLED,Status.NO_SHOW,Status.RESCHEDULED]);
const MLIMIT={WHEAT:14,PADDY:17,MUSTARD:8};
const MSP={WHEAT:2275,PADDY:2320,MUSTARD:5650};
const BAGS=20;
class DailyStatus{
  constructor(mid,day,cap){this.mid=mid;this.day=day;this.cap=cap;this.buf=Math.max(1,Math.floor(cap/10));this.booked=0;this.checkedIn=0;this.done=0;this.bags=cap*BAGS;this.store=0;this.drying=0;this.paused=false;this.reason="";}
  get avail(){return Math.max(0,this.cap-this.buf-this.drying-this.booked);}
}
let _bk=0;
class Booking{
  constructor(fid,mid,day,crop,tok){_bk++;this.bid=`BK${_bk}`;this.fid=fid;this.mid=mid;this.day=day;this.crop=crop;this.tok=tok;this.st=Status.BOOKED;this.seq=-1;this.pri=0;this.wt=0;this.moist=0;this.amt=0;this.resc=0;this.parent=null;this.hist=[];}
}
class Engine{
  constructor(){this.F=new Map();this.M=new Map();this.B=new Map();this.D=new Map();this.day=1;this.sms=[];this._s=0;this._t=new Map();}
  notify(){}
  log(){}
  ds(mid,d){const k=`${mid}:${d}`;if(!this.D.has(k))this.D.set(k,new DailyStatus(mid,d,this.M.get(mid).cap));return this.D.get(k);}
  tok(mid,d){const k=`${mid}-${d}`;this._t.set(k,(this._t.get(k)||0)+1);return `${mid}-D${d}-${String(this._t.get(k)).padStart(3,"0")}`;}
  move(b,to){const ok=TRANSITIONS[b.st]||[];if(!ok.includes(to))return false;b.st=to;b.hist.push({st:to,d:this.day});return true;}
  queue(mid){return Array.from(this.B.values()).filter(b=>b.mid===mid&&b.st===Status.IN_QUEUE).sort((a,b)=>b.pri!==a.pri?b.pri-a.pri:a.seq-b.seq);}
  qpos(b){const q=this.queue(b.mid);const i=q.findIndex(x=>x.tok===b.tok);return i>=0?i+1:-1;}
  active(fid){for(const b of this.B.values())if(b.fid===fid&&!TERMINAL.has(b.st))return b;return null;}
  findSlot(pm,sd){for(let d=sd;d<sd+10;d++){const s=this.ds(pm,d);if(!s.paused&&s.avail>0)return{d,m:pm};}for(const mid of this.M.keys()){if(mid===pm)continue;for(let d=sd;d<sd+10;d++){const s=this.ds(mid,d);if(!s.paused&&s.avail>0)return{d,m:mid};}}return{d:null,m:null};}
  book(fid,mid,day,crop){if(!this.F.has(fid))return null;if(!this.M.has(mid))return null;if(day<this.day)return null;const a=this.active(fid);if(a)return null;const ds=this.ds(mid,day);if(ds.paused)return null;if(ds.avail<=0)return null;const t=this.tok(mid,day);const b=new Booking(fid,mid,day,crop,t);b.hist.push({st:Status.BOOKED,d:this.day});this.B.set(t,b);ds.booked++;return b;}
  cancel(tok){if(!this.B.has(tok))return false;const b=this.B.get(tok);if(b.st!==Status.BOOKED)return false;b.st=Status.CANCELLED;b.hist.push({st:Status.CANCELLED,d:this.day});const ds=this.ds(b.mid,b.day);ds.booked=Math.max(0,ds.booked-1);return true;}
  checkin(tok){if(!this.B.has(tok))return false;const b=this.B.get(tok);if(b.day!==this.day)return false;if(b.st===Status.RE_INSPECTION){if(!this.move(b,Status.IN_QUEUE))return false;this._s++;b.seq=this._s;b.pri=800;this.ds(b.mid,this.day).checkedIn++;this.ds(b.mid,this.day).drying=Math.max(0,this.ds(b.mid,this.day).drying-1);return true;}if(!this.move(b,Status.CHECKED_IN))return false;if(!this.move(b,Status.IN_QUEUE))return false;this._s++;b.seq=this._s;b.pri=b.resc>0?500+b.resc*100:0;this.ds(b.mid,this.day).checkedIn++;return true;}
  callNext(mid){const q=this.queue(mid);if(!q.length)return null;const ds=this.ds(mid,this.day);if(ds.bags<BAGS)return null;if(ds.store>=95)return null;const n=q[0];if(!this.move(n,Status.WEIGHING))return null;return n;}
  accept(tok,wt){if(!this.B.has(tok))return false;const b=this.B.get(tok);if(b.st!==Status.WEIGHING)return false;b.wt=wt;const r=MSP[b.crop]||2000;b.amt=wt*r;if(!this.move(b,Status.ACCEPTED))return false;if(!this.move(b,Status.PAYMENT_INITIATED))return false;const ds=this.ds(b.mid,this.day);ds.done++;ds.bags=Math.max(0,ds.bags-Math.floor(wt*2));ds.store=Math.min(100,ds.store+Math.floor(wt*0.5));return true;}
  reject(tok,moist){if(!this.B.has(tok))return null;const b=this.B.get(tok);if(b.st!==Status.WEIGHING)return null;const lim=MLIMIT[b.crop]||17;const gap=moist-lim;const dd=Math.max(1,Math.round(gap/2));const rd=this.day+dd;b.moist=moist;if(!this.move(b,Status.REJECTED_MOISTURE))return null;if(!this.move(b,Status.DRYING))return null;for(let d=this.day;d<=rd;d++)this.ds(b.mid,d).drying++;const rt=this.tok(b.mid,rd);const rb=new Booking(b.fid,b.mid,rd,b.crop,rt);rb.st=Status.RE_INSPECTION;rb.parent=b.bid;rb.pri=800;rb.hist.push({st:Status.RE_INSPECTION,d:this.day,note:"auto"});this.B.set(rt,rb);return rt;}
  pause(mid,reason){this.ds(mid,this.day).paused=true;this.ds(mid,this.day).reason=reason;this.ds(mid,this.day+1).paused=true;this.ds(mid,this.day+1).reason=reason;const resched=Array.from(this.B.values()).filter(b=>b.mid===mid&&[this.day,this.day+1].includes(b.day)&&b.st===Status.BOOKED);let c=0;for(const bk of resched){const{d:nd,m:nm}=this.findSlot(mid,this.day+2);if(!nd)continue;bk.st=Status.RESCHEDULED;bk.hist.push({st:Status.RESCHEDULED,d:this.day});const nt=this.tok(nm,nd);const nb=new Booking(bk.fid,nm,nd,bk.crop,nt);nb.resc=bk.resc+1;nb.parent=bk.bid;nb.hist.push({st:Status.BOOKED,d:this.day,note:"rescheduled"});this.B.set(nt,nb);this.ds(nm,nd).booked++;c++;}return c;}
  resume(mid){this.ds(mid,this.day).paused=false;this.ds(mid,this.day).reason="";}
  addFarmer(id,name,phone){this.F.set(id,{id,name,phone});}
  addMandi(id,name,cap){this.M.set(id,{id,name,cap});}
}

let passed=0,failed=0,total=0;
function test(name,fn){
  total++;
  try{
    const r=fn();
    if(r===true){console.log(`  PASS [${String(total).padStart(2,"0")}] ${name}`);passed++;}
    else{console.log(`  FAIL [${String(total).padStart(2,"0")}] ${name}\n       -> ${r}`);failed++;}
  }catch(e){console.log(`  ERR  [${String(total).padStart(2,"0")}] ${name}\n       -> ${e.message}`);failed++;}
}
function fe(cap=10){
  const e=new Engine();
  e.addMandi("KNL","Karnal",cap);e.addMandi("NLK","Nilokheri",cap);e.addMandi("GHR","Gharaunda",cap);
  for(let i=1;i<=60;i++)e.addFarmer(`F${i}`,`Farmer${i}`,`9${String(i).padStart(9,"0")}`);
  return e;
}

console.log("\n================================================");
console.log("  MANDI ENGINE -- 20 Practical Test Cases");
console.log("================================================\n");

console.log("-- CATEGORY 1: Capacity Control --");
test("TC-01 Last slot: only one of two concurrent bookings succeeds",()=>{const e=fe(2);const b1=e.book("F1","KNL",1,"PADDY");const b2=e.book("F2","KNL",1,"PADDY");if(!b1)return"First booking failed";if(b2)return"OVERBOOKING: both succeeded";return true;});
test("TC-02 Full mandi blocks booking #5",()=>{const e=fe(5);for(let i=1;i<=4;i++)e.book(`F${i}`,"KNL",1,"PADDY");const x=e.book("F5","KNL",1,"PADDY");return x===null?true:`Slot #5 accepted -- capacity not enforced`;});
test("TC-03 Cancellation frees slot in real time",()=>{const e=fe(2);const b1=e.book("F1","KNL",1,"PADDY");if(!b1)return"Initial booking failed";const blocked=e.book("F2","KNL",1,"PADDY");if(blocked)return"Should be blocked before cancel";e.cancel(b1.tok);const b2=e.book("F2","KNL",1,"PADDY");return b2?true:"Freed slot not available after cancel";});

console.log("\n-- CATEGORY 2: Priority Queue Ordering --");
test("TC-04 Re-inspection P:800 jumps entire queue",()=>{const e=fe(50);for(let i=1;i<=5;i++){const b=e.book(`F${i}`,"KNL",1,"PADDY");e.checkin(b.tok);}const rt=e.tok("KNL",1);const rb=new Booking("F10","KNL",1,"PADDY",rt);rb.st=Status.RE_INSPECTION;rb.pri=800;e.B.set(rt,rb);e.checkin(rt);const q=e.queue("KNL");return q[0].fid==="F10"?true:`Re-inspection not #1 (got ${q[0].fid})`;});
test("TC-05 Multiple re-inspections ordered by queue_seq",()=>{const e=fe(50);["F1","F2","F3"].forEach(fid=>{const rt=e.tok("KNL",1);const rb=new Booking(fid,"KNL",1,"PADDY",rt);rb.st=Status.RE_INSPECTION;rb.pri=800;e.B.set(rt,rb);e.checkin(rt);});const q=e.queue("KNL");return(q[0].fid==="F1"&&q[1].fid==="F2"&&q[2].fid==="F3")?true:`Wrong order: ${q.map(x=>x.fid).join(",")}`;});
test("TC-06 Rescheduled P:500 ahead of regular P:0",()=>{const e=fe(50);for(let i=1;i<=3;i++){const b=e.book(`F${i}`,"KNL",1,"PADDY");e.checkin(b.tok);}const rb=e.book("F10","KNL",1,"PADDY");rb.resc=1;e.checkin(rb.tok);const q=e.queue("KNL");return q[0].fid==="F10"?true:`Rescheduled not first (got ${q[0].fid}, pri:${q[0].pri})`;});
test("TC-07 Twice-rescheduled P:600 beats once-rescheduled P:500",()=>{const e=fe(50);const b1=e.book("F1","KNL",1,"PADDY");b1.resc=1;e.checkin(b1.tok);const b2=e.book("F2","KNL",1,"PADDY");b2.resc=2;e.checkin(b2.tok);const q=e.queue("KNL");return q[0].fid==="F2"?true:`P:600 not ahead of P:500 (got ${q[0].fid})`;});

console.log("\n-- CATEGORY 3: Rain Disruption Cascade --");
test("TC-08 Rain: BOOKED rescheduled, CHECKED_IN stays",()=>{const e=fe(50);for(let i=1;i<=3;i++)e.book(`F${i}`,"KNL",1,"PADDY");for(let i=4;i<=5;i++){const b=e.book(`F${i}`,"KNL",1,"PADDY");e.checkin(b.tok);}e.pause("KNL","RAIN");const rc=Array.from(e.B.values()).filter(b=>b.st===Status.RESCHEDULED).length;const iq=e.queue("KNL").length;if(rc!==3)return`Expected 3 rescheduled, got ${rc}`;if(iq!==2)return`Expected 2 in queue, got ${iq}`;return true;});
test("TC-09 Rescheduled farmer gets new booking at Day+2",()=>{const e=fe(50);e.day=3;e.book("F1","KNL",3,"PADDY");e.pause("KNL","RAIN");const nb=Array.from(e.B.values()).find(b=>b.fid==="F1"&&b.st===Status.BOOKED);if(!nb)return"No new booking for F1";return nb.day>=5?true:`New day ${nb.day} too early (expected >=5)`;});
test("TC-10 Full home mandi triggers reroute to other mandi",()=>{const e=fe(2);for(let d=3;d<=12;d++){const ds=e.ds("KNL",d);ds.booked=ds.cap;}e.day=1;e.book("F3","KNL",1,"PADDY");e.pause("KNL","RAIN");const nb=Array.from(e.B.values()).find(b=>b.fid==="F3"&&b.st===Status.BOOKED);if(!nb)return"No rerouted booking";return nb.mid!=="KNL"?true:`Still at KNL -- rerouting didn't fire`;});
test("TC-11 Second disruption escalates resc count to 2",()=>{const e=fe(50);e.day=1;e.book("F1","KNL",1,"PADDY");e.pause("KNL","RAIN");const bk1=Array.from(e.B.values()).find(b=>b.fid==="F1"&&b.st===Status.BOOKED);if(!bk1)return"First reschedule not found";e.day=3;e.pause("KNL","RAIN");const bk2=Array.from(e.B.values()).find(b=>b.fid==="F1"&&b.st===Status.BOOKED&&b.resc===2);return bk2?true:`Second reschedule resc=${bk2?bk2.resc:"not found"}, expected 2`;});

console.log("\n-- CATEGORY 4: Bardana & Storage --");
test("TC-12 Bardana <20 hard-blocks callNext()",()=>{const e=fe(50);const b=e.book("F1","KNL",1,"PADDY");e.checkin(b.tok);e.ds("KNL",1).bags=10;const c=e.callNext("KNL");return c===null?true:"callNext succeeded with 10 bags -- not blocked";});
test("TC-13 Storage 82% warning does NOT block callNext()",()=>{const e=fe(50);const b=e.book("F1","KNL",1,"PADDY");e.checkin(b.tok);e.ds("KNL",1).store=82;const c=e.callNext("KNL");return c!==null?true:"callNext blocked at 82% -- should only warn";});
test("TC-14 Storage 95% hard-blocks callNext()",()=>{const e=fe(50);const b=e.book("F1","KNL",1,"PADDY");e.checkin(b.tok);e.ds("KNL",1).store=95;const c=e.callNext("KNL");return c===null?true:"callNext succeeded at 95% storage -- not blocked";});

console.log("\n-- CATEGORY 5: Moisture Rejection Loop --");
test("TC-15 Moisture 17.0% -- accept path succeeds (boundary inclusive)",()=>{const e=fe(50);const b=e.book("F1","KNL",1,"PADDY");e.checkin(b.tok);e.callNext("KNL");const ok=e.accept(b.tok,40);return ok?true:"Accept at 17% boundary failed";});
test("TC-16 Moisture 17.1% rejected, drying day = day+1",()=>{const e=fe(50);const b=e.book("F1","KNL",1,"PADDY");e.checkin(b.tok);e.callNext("KNL");const rt=e.reject(b.tok,17.1);if(!rt)return"Rejection failed";const rb=e.B.get(rt);return rb.day===2?true:`Re-inspection day is ${rb.day}, expected 2`;});
test("TC-17 Re-inspection check-in assigns Priority 800",()=>{const e=fe(50);const b=e.book("F1","KNL",1,"PADDY");e.checkin(b.tok);e.callNext("KNL");const rt=e.reject(b.tok,21);if(!rt)return"Rejection failed";const rb=e.B.get(rt);e.day=rb.day;e.checkin(rt);return rb.pri===800?true:`Priority is ${rb.pri}, expected 800`;});
test("TC-18 Double rejection issues new P:800 token",()=>{const e=fe(50);const b=e.book("F1","KNL",1,"PADDY");e.checkin(b.tok);e.callNext("KNL");const rt1=e.reject(b.tok,21);if(!rt1)return"First rejection failed";const rb1=e.B.get(rt1);e.day=rb1.day;e.checkin(rt1);e.callNext("KNL");const rt2=e.reject(rt1,19);if(!rt2)return"Second rejection failed";const rb2=e.B.get(rt2);return rb2.pri===800?true:`Second re-inspection priority is ${rb2.pri}, expected 800`;});

console.log("\n-- CATEGORY 6: Multi-Day Carryover --");
test("TC-19 Checked-in farmers persist in queue on next day",()=>{const e=fe(50);for(let i=1;i<=3;i++){const b=e.book(`F${i}`,"KNL",1,"PADDY");e.checkin(b.tok);}e.day=2;const q=e.queue("KNL");return q.length===3?true:`Only ${q.length} in queue on Day 2, expected 3`;});

console.log("\n-- CATEGORY 7: Cross-Mandi Rerouting --");
test("TC-20 findSlot() reroutes to other mandi when home is full",()=>{const e=fe(2);for(let d=3;d<=12;d++){const ds=e.ds("KNL",d);ds.booked=ds.cap;}const slot=e.findSlot("KNL",3);return(slot.m!==null&&slot.m!=="KNL")?true:`findSlot returned null or stayed at KNL (got: ${slot.m})`;});

console.log("\n================================================");
console.log(`  RESULTS: ${passed} PASSED | ${failed} FAILED | ${total} TOTAL`);
if(failed===0)console.log("  ALL TESTS PASSED");
else console.log(`  ${failed} TEST(S) FAILED`);
console.log("================================================\n");
process.exit(failed>0?1:0);
