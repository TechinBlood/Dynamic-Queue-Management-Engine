/**
 * ================================================================
 * MANDI QUEUE ENGINE — Interactive Menu-Driven Sandbox
 * ================================================================
 * SIH 2026 | PS 26032 | DoCA
 *
 * RUN:   node mandi_sandbox.js
 *
 * Crop: PADDY (Kharif Season, Oct-Nov, Haryana)
 * Pre-loaded with 3 mandis and 15 farmers.
 * You control every action. Break it, stress-test it, find the edge cases.
 * ================================================================
 */

const readline = require('readline');

// ─── CONSTANTS ────────────────────────────────────────────────
const Status = Object.freeze({
  BOOKED:'BOOKED', CHECKED_IN:'CHECKED_IN', IN_QUEUE:'IN_QUEUE',
  WEIGHING:'WEIGHING', ACCEPTED:'ACCEPTED',
  REJECTED_MOISTURE:'REJECTED_MOISTURE', DRYING:'DRYING',
  RE_INSPECTION:'RE_INSPECTION', PAYMENT_INITIATED:'PAYMENT_INITIATED',
  PAID:'PAID', CANCELLED:'CANCELLED', NO_SHOW:'NO_SHOW',
  RESCHEDULED:'RESCHEDULED'
});

const TRANSITIONS = {
  [Status.BOOKED]:            [Status.CHECKED_IN, Status.CANCELLED, Status.NO_SHOW, Status.RESCHEDULED],
  [Status.CHECKED_IN]:        [Status.IN_QUEUE],
  [Status.IN_QUEUE]:          [Status.WEIGHING],
  [Status.WEIGHING]:          [Status.ACCEPTED, Status.REJECTED_MOISTURE],
  [Status.ACCEPTED]:          [Status.PAYMENT_INITIATED],
  [Status.PAYMENT_INITIATED]: [Status.PAID],
  [Status.REJECTED_MOISTURE]: [Status.DRYING],
  [Status.DRYING]:            [Status.RE_INSPECTION],
  [Status.RE_INSPECTION]:     [Status.IN_QUEUE],
};

const TERMINAL = new Set([Status.PAID, Status.CANCELLED, Status.NO_SHOW, Status.RESCHEDULED]);
const Crop     = { WHEAT:'WHEAT', PADDY:'PADDY', MUSTARD:'MUSTARD' };
const MLIMIT   = { WHEAT:14, PADDY:17, MUSTARD:8 };
const MSP      = { WHEAT:2275, PADDY:2320, MUSTARD:5650 };
const BAGS     = 20;

// ─── DATA MODELS ──────────────────────────────────────────────
class DailyStatus {
  constructor(mid, day, cap) {
    this.mid=mid; this.day=day; this.cap=cap;
    this.buf=Math.max(1,Math.floor(cap/10));
    this.booked=0; this.checkedIn=0; this.done=0;
    this.bags=cap*BAGS; this.store=0; this.drying=0;
    this.paused=false; this.reason='';
  }
  get avail() { return Math.max(0, this.cap - this.buf - this.drying - this.booked); }
}

let _bk=0;
class Booking {
  constructor(fid,mid,day,crop,tok) {
    _bk++; this.bid=`BK${_bk}`;
    this.fid=fid; this.mid=mid; this.day=day; this.crop=crop; this.tok=tok;
    this.st=Status.BOOKED; this.seq=-1; this.pri=0;
    this.wt=0; this.moist=0; this.amt=0; this.resc=0;
    this.parent=null; this.hist=[];
  }
}

// ─── ENGINE ───────────────────────────────────────────────────
class Engine {
  constructor() {
    this.F=new Map(); this.M=new Map(); this.B=new Map();
    this.D=new Map(); this.day=1; this.sms=[]; this._s=0; this._t=new Map();
  }

  notify(fid,msg) {
    const f=this.F.get(fid);
    const l=`  [SMS] -> ${f.name} (${f.phone}): ${msg}`;
    this.sms.push({day:this.day, to:f.name, msg}); console.log(l);
  }
  log(m) { console.log(`  [SYS]  ${m}`); }

  ds(mid,d) {
    const k=`${mid}:${d}`;
    if(!this.D.has(k)) this.D.set(k, new DailyStatus(mid,d,this.M.get(mid).cap));
    return this.D.get(k);
  }

  tok(mid,d) {
    const k=`${mid}-${d}`;
    this._t.set(k,(this._t.get(k)||0)+1);
    return `${mid}-D${d}-${String(this._t.get(k)).padStart(3,'0')}`;
  }

  move(b,to) {
    const ok=TRANSITIONS[b.st]||[];
    if(!ok.includes(to)) {
      console.log(`  [ERROR] ILLEGAL: ${b.st} → ${to}`);
      console.log(`     Allowed from ${b.st}: [${ok.join(', ')}]`);
      return false;
    }
    const old=b.st; b.st=to;
    b.hist.push({st:to, d:this.day});
    this.log(`${old} → ${to}  [${b.tok}]`);
    return true;
  }

  queue(mid) {
    return Array.from(this.B.values())
      .filter(b=>b.mid===mid && b.day===this.day && b.st===Status.IN_QUEUE)
      .sort((a,b)=> b.pri!==a.pri ? b.pri-a.pri : a.seq-b.seq);
  }

  qpos(b) { const q=this.queue(b.mid); const i=q.findIndex(x=>x.tok===b.tok); return i>=0?i+1:-1; }

  active(fid) {
    for(const b of this.B.values()) if(b.fid===fid && !TERMINAL.has(b.st)) return b;
    return null;
  }

  findSlot(pm,sd) {
    for(let d=sd;d<sd+10;d++){const s=this.ds(pm,d);if(!s.paused&&s.avail>0)return{d,m:pm};}
    for(const mid of this.M.keys()){if(mid===pm)continue;
      for(let d=sd;d<sd+10;d++){const s=this.ds(mid,d);if(!s.paused&&s.avail>0)return{d,m:mid};}}
    return {d:null,m:null};
  }

  // ── OPERATIONS ──

  book(fid,mid,day,crop) {
    if(!this.F.has(fid)){console.log(`  [ERROR] Farmer ${fid} not registered`);return null;}
    if(!this.M.has(mid)){console.log(`  [ERROR] Mandi ${mid} not found`);return null;}
    if(day<this.day){console.log(`  [ERROR] Can't book past (today=Day ${this.day})`);return null;}
    const a=this.active(fid);
    if(a){console.log(`  [ERROR] ${this.F.get(fid).name} has active: ${a.tok} (${a.st})`);return null;}
    const ds=this.ds(mid,day);
    if(ds.paused){console.log(`  [ERROR] ${this.M.get(mid).name} PAUSED: ${ds.reason}`);return null;}
    if(ds.avail<=0){console.log(`  [ERROR] FULL: ${this.M.get(mid).name} Day ${day} (${ds.booked}/${ds.cap-ds.buf} booked)`);return null;}
    if(ds.bags<BAGS) console.log(`  [WARN]  LOW BARDANA WARNING: ${ds.bags} bags left`);

    const t=this.tok(mid,day);
    const b=new Booking(fid,mid,day,crop,t);
    b.hist.push({st:Status.BOOKED,d:this.day});
    this.B.set(t,b); ds.booked++;
    this.log(`BOOKED: ${this.F.get(fid).name} → ${this.M.get(mid).name} Day ${day} [${t}]`);
    this.notify(fid,`[OK] Token: ${t} | ${this.M.get(mid).name} Day ${day} | ${crop}`);
    return b;
  }

  cancel(tok) {
    if(!this.B.has(tok)){console.log(`  [ERROR] Token ${tok} not found`);return false;}
    const b=this.B.get(tok);
    if(b.st!==Status.BOOKED){console.log(`  [ERROR] Can only cancel BOOKED tokens (current: ${b.st})`);return false;}
    b.st=Status.CANCELLED; b.hist.push({st:Status.CANCELLED,d:this.day});
    const ds=this.ds(b.mid,b.day); ds.booked=Math.max(0,ds.booked-1);
    this.log(`CANCELLED: ${tok}`);
    this.notify(b.fid,`[ERROR] Token ${tok} cancelled. Book again anytime.`);
    return true;
  }

  checkin(tok) {
    if(!this.B.has(tok)){console.log(`  [ERROR] Token ${tok} not found`);return false;}
    const b=this.B.get(tok);
    if(b.day!==this.day){console.log(`  [ERROR] Token for Day ${b.day}, today is Day ${this.day}`);return false;}

    if(b.st===Status.RE_INSPECTION) {
      if(!this.move(b,Status.IN_QUEUE))return false;
      this._s++; b.seq=this._s; b.pri=800;
      this.ds(b.mid,this.day).checkedIn++;
      this.ds(b.mid,this.day).drying=Math.max(0,this.ds(b.mid,this.day).drying-1);
      const p=this.qpos(b);
      this.notify(b.fid,`[RE-SYNC] Re-inspection checkin | ${tok} | Queue #${p}`);
      return true;
    }

    if(!this.move(b,Status.CHECKED_IN))return false;
    if(!this.move(b,Status.IN_QUEUE))return false;
    this._s++; b.seq=this._s;
    b.pri = b.resc>0 ? 500+b.resc*100 : 0;
    this.ds(b.mid,this.day).checkedIn++;
    const p=this.qpos(b);
    this.notify(b.fid,`[OK] Checked in | ${tok} | Queue #${p}`);
    return true;
  }

  callNext(mid) {
    const q=this.queue(mid);
    if(!q.length){console.log(`  [INFO]  Queue empty at ${this.M.get(mid).name}`);return null;}
    const ds=this.ds(mid,this.day);
    if(ds.bags<BAGS){
      console.log(`  [ERROR] BARDANA EXHAUSTED (${ds.bags} bags, need ${BAGS})`);
      this.log('Recommend: Pause mandi & reschedule.');
      return null;
    }
    const n=q[0];
    if(!this.move(n,Status.WEIGHING))return null;
    this.notify(n.fid,`[CALL] YOUR TURN! Token ${n.tok} → Weighing Bridge`);
    this.queue(mid).slice(0,2).forEach((b,i)=>
      this.notify(b.fid,`Queue update: Position #${i+1}`));
    return n;
  }

  accept(tok,wt) {
    if(!this.B.has(tok)){console.log(`  [ERROR] Token not found`);return false;}
    const b=this.B.get(tok);
    if(b.st!==Status.WEIGHING){console.log(`  [ERROR] ${tok} is ${b.st}, not WEIGHING`);return false;}
    b.wt=wt; const r=MSP[b.crop]||2000; b.amt=wt*r;
    if(!this.move(b,Status.ACCEPTED))return false;
    if(!this.move(b,Status.PAYMENT_INITIATED))return false;
    const ds=this.ds(b.mid,this.day);
    ds.done++; ds.bags=Math.max(0,ds.bags-Math.floor(wt*2));
    ds.store=Math.min(100,ds.store+Math.floor(wt*0.5));
    this.notify(b.fid,`[OK] ${wt}q × ₹${r} = ₹${b.amt.toLocaleString('en-IN')} | DBT INITIATED`);
    return true;
  }

  reject(tok,moist) {
    if(!this.B.has(tok)){console.log(`  [ERROR] Token not found`);return null;}
    const b=this.B.get(tok);
    if(b.st!==Status.WEIGHING){console.log(`  [ERROR] ${tok} is ${b.st}, not WEIGHING`);return null;}
    const lim=MLIMIT[b.crop]||17; const gap=moist-lim;
    const dd=Math.max(1,Math.round(gap/2)); const rd=this.day+dd;
    b.moist=moist;
    if(!this.move(b,Status.REJECTED_MOISTURE))return null;
    if(!this.move(b,Status.DRYING))return null;
    for(let d=this.day;d<=rd;d++) this.ds(b.mid,d).drying++;

    const rt=this.tok(b.mid,rd);
    const rb=new Booking(b.fid,b.mid,rd,b.crop,rt);
    rb.st=Status.RE_INSPECTION; rb.parent=b.bid; rb.pri=800;
    rb.hist.push({st:Status.RE_INSPECTION,d:this.day,note:'auto'});
    this.B.set(rt,rb);
    this.notify(b.fid,`[ERROR] Moisture ${moist}% (limit ${lim}%) | Dry ~${dd}d | Re-inspect Day ${rd} | Token: ${rt}`);
    return rt;
  }

  pause(mid,reason) {
    const m=this.M.get(mid);
    this.ds(mid,this.day).paused=true; this.ds(mid,this.day).reason=reason;
    this.ds(mid,this.day+1).paused=true; this.ds(mid,this.day+1).reason=reason;
    this.log(`[PAUSED] PAUSED: ${m.name} | ${reason}`);
    this.log('Farmers IN_QUEUE/WEIGHING stay (physically present).');

    const resched=Array.from(this.B.values()).filter(
      b=>b.mid===mid && [this.day,this.day+1].includes(b.day) && b.st===Status.BOOKED);
    let c=0;
    for(const bk of resched) {
      const {d:nd,m:nm}=this.findSlot(mid,this.day+2);
      if(!nd){this.notify(bk.fid,`[WARN] ${m.name} PAUSED. No nearby slots. DO NOT travel.`);continue;}
      bk.st=Status.RESCHEDULED; bk.hist.push({st:Status.RESCHEDULED,d:this.day});
      const nt=this.tok(nm,nd);
      const nb=new Booking(bk.fid,nm,nd,bk.crop,nt);
      nb.resc=bk.resc+1; nb.parent=bk.bid;
      nb.hist.push({st:Status.BOOKED,d:this.day,note:'rescheduled'});
      this.B.set(nt,nb); this.ds(nm,nd).booked++;
      const dest=this.M.get(nm).name;
      this.notify(bk.fid, nm===mid
        ? `[WARN] Rescheduled → ${dest} Day ${nd} | Token: ${nt}`
        : `[WARN] Rerouted → ${dest} Day ${nd} | Token: ${nt}`);
      c++;
    }
    this.log(`Rescheduled ${c} farmer(s).`);
    return c;
  }

  resume(mid) {
    this.ds(mid,this.day).paused=false; this.ds(mid,this.day).reason='';
    this.log(`[ACTIVE] RESUMED: ${this.M.get(mid).name}`);
  }

  noShows(mid) {
    const ns=Array.from(this.B.values()).filter(
      b=>b.mid===mid && b.day===this.day && b.st===Status.BOOKED);
    for(const b of ns){
      b.st=Status.NO_SHOW; b.hist.push({st:Status.NO_SHOW,d:this.day});
      this.notify(b.fid,`[EXPIRED] MISSED: Token ${b.tok} expired.`);
    }
    if(ns.length){
      this.ds(mid,this.day).buf+=ns.length;
      this.log(`${ns.length} no-show(s). Buffer now ${this.ds(mid,this.day).buf}.`);
    }
    return ns.length;
  }

  setBags(mid,day,n) {
    this.ds(mid,day).bags=n;
    this.log(`Bardana at ${this.M.get(mid).name} Day ${day}: ${n} bags`);
  }

  setStorage(mid,day,pct) {
    this.ds(mid,day).store=pct;
    this.log(`Storage at ${this.M.get(mid).name} Day ${day}: ${pct}%`);
  }

  paid(tok) {
    if(!this.B.has(tok))return;
    const b=this.B.get(tok);
    if(b.st!==Status.PAYMENT_INITIATED){console.log(`  [ERROR] ${tok} is ${b.st}`);return;}
    b.st=Status.PAID; b.hist.push({st:Status.PAID,d:this.day});
    this.notify(b.fid,`[PAID] ₹${b.amt.toLocaleString('en-IN')} credited!`);
  }

  nextDay() {
    this.day++;
    console.log(`\n  ${'═'.repeat(20)} DAY DAY ${this.day} ${'═'.repeat(20)}\n`);
    for(const b of this.B.values())
      if(b.st===Status.RE_INSPECTION && b.day===this.day)
        this.log(`[CALL] Re-inspection due: ${b.tok} (${this.F.get(b.fid).name})`);
  }

  // ── VIEWS ──

  showMandi(mid) {
    const m=this.M.get(mid), ds=this.ds(mid,this.day), q=this.queue(mid);
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`  LOCATION: ${m.name} | DAY ${this.day}`);
    console.log(`${'━'.repeat(60)}`);
    console.log(`  Status:    ${ds.paused?'[PAUSED] PAUSED ('+ds.reason+')':'[ACTIVE] ACTIVE'}`);
    console.log(`  Capacity:  ${ds.cap}/day (buffer:${ds.buf} drying:${ds.drying})`);
    console.log(`  Booked:${ds.booked} | CheckedIn:${ds.checkedIn} | Done:${ds.done}`);
    console.log(`  Bookable:  ${ds.avail} slot(s)`);
    console.log(`  Bardana:   ${ds.bags} bags`);
    console.log(`  Storage:   ${ds.store}%`);
    if(q.length){
      console.log(`\n  QUEUE QUEUE (${q.length}):`);
      q.forEach((b,i)=>{
        const fn=this.F.get(b.fid).name;
        const p=b.pri?` [pri:${b.pri}]`:'';
        const r=b.resc?` (resched×${b.resc})`:'';
        console.log(`    #${i+1}  ${fn.padEnd(20)} ${b.tok}${p}${r}`);
      });
    }
    const w=Array.from(this.B.values()).filter(b=>b.mid===mid&&b.day===this.day&&b.st===Status.WEIGHING);
    if(w.length){console.log(`\n  WEIGHBRIDGE:  WEIGHING:`);w.forEach(b=>console.log(`    ${this.F.get(b.fid).name.padEnd(20)} ${b.tok}`));}
    const dr=Array.from(this.B.values()).filter(b=>b.mid===mid&&b.st===Status.DRYING);
    if(dr.length){
      console.log(`\n  SUN-DRYING:  DRYING:`);
      dr.forEach(b=>{
        const ri=Array.from(this.B.values()).find(x=>x.parent===b.bid&&x.st===Status.RE_INSPECTION);
        console.log(`    ${this.F.get(b.fid).name.padEnd(20)} moist:${b.moist}% reinspect:Day ${ri?ri.day:'?'}`);
      });
    }
    const bk=Array.from(this.B.values()).filter(b=>b.mid===mid&&b.day===this.day&&b.st===Status.BOOKED);
    if(bk.length){
      console.log(`\n  DAY BOOKED (not yet arrived):`);
      bk.forEach(b=>console.log(`    ${this.F.get(b.fid).name.padEnd(20)} ${b.tok}`));
    }
    console.log(`${'━'.repeat(60)}\n`);
  }

  showFarmer(fid) {
    if(!this.F.has(fid)){console.log(`  [ERROR] ${fid} not found`);return;}
    const f=this.F.get(fid);
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  FARMER: ${f.name} | ${f.village}, ${f.district} | ${f.acres} acres`);
    console.log(`  PHONE: ${f.phone}`);
    const bks=Array.from(this.B.values()).filter(b=>b.fid===fid);
    if(bks.length){
      console.log(`  RECORDS: BOOKINGS:`);
      const ic={BOOKED:'SCHEDULED',IN_QUEUE:'IN_QUEUE',WEIGHING:'WEIGHBRIDGE',ACCEPTED:'[OK]',PAID:'[PAID]',
        CANCELLED:'[ERROR]',NO_SHOW:'[EXPIRED]',RESCHEDULED:'[RE-SYNC]',DRYING:'DRYING',RE_INSPECTION:'[RE-SYNC]',
        REJECTED_MOISTURE:'MOISTURE',PAYMENT_INITIATED:'PAYMENT_INITIATED',CHECKED_IN:'QUEUE'};
      bks.forEach(b=>{
        let x='';
        if(b.wt)x+=` | ${b.wt}q=₹${b.amt.toLocaleString('en-IN')}`;
        if(b.moist)x+=` | moist:${b.moist}%`;
        if(b.resc)x+=` | resched×${b.resc}`;
        console.log(`    ${ic[b.st]||'•'} ${b.tok} | ${this.M.get(b.mid).name} D${b.day} | ${b.st}${x}`);
        b.hist.forEach(h=>console.log(`       └─ ${h.st} (Day ${h.d})${h.note?' '+h.note:''}`));
      });
    } else console.log('  No bookings.');
    console.log(`${'─'.repeat(55)}\n`);
  }

  showAll() {
    console.log(`\n${'═'.repeat(62)}`);
    console.log(`  DISTRICT OVERVIEW | DAY ${this.day}`);
    console.log(`${'═'.repeat(62)}`);
    for(const [mid,m] of this.M.entries()){
      const ds=this.ds(mid,this.day), ql=this.queue(mid).length;
      console.log(`  ${ds.paused?'[PAUSED]':'[ACTIVE]'} ${m.name.padEnd(18)} Bkd:${String(ds.booked).padStart(2)}/${ds.cap} Q:${String(ql).padStart(2)} Done:${String(ds.done).padStart(2)} Bags:${String(ds.bags).padStart(4)} Store:${ds.store}%`);
    }
    console.log(`${'═'.repeat(62)}\n`);
  }

  showFarmers() {
    console.log(`\n  FARMER REGISTRY ALL FARMERS (Day ${this.day}):`);
    console.log(`  ${'─'.repeat(55)}`);
    for(const [fid,f] of this.F.entries()){
      const a=this.active(fid);
      const st=a?`${a.tok} [${a.st}]`:'available';
      console.log(`  ${fid.padEnd(5)} ${f.name.padEnd(20)} ${f.village.padEnd(12)} ${st}`);
    }
    console.log(`  ${'─'.repeat(55)}\n`);
  }

  showSlots(mid) {
    console.log(`\n  DAY SLOT AVAILABILITY: ${this.M.get(mid).name}`);
    console.log(`  ${'─'.repeat(40)}`);
    for(let d=this.day; d<=this.day+6; d++){
      const ds=this.ds(mid,d);
      const bar='█'.repeat(ds.booked)+'░'.repeat(Math.max(0,ds.cap-ds.buf-ds.drying-ds.booked));
      const st=ds.paused?'[PAUSED] PAUSED':'';
      console.log(`  Day ${String(d).padStart(2)}: [${bar}] ${ds.booked}/${ds.cap-ds.buf} booked (${ds.avail} free) ${st}`);
    }
    console.log(`  ${'─'.repeat(40)}\n`);
  }

  showSMS(n=20) {
    console.log(`\n  [SMS] SMS LOG (last ${n}):`);
    this.sms.slice(-n).forEach(s=>
      console.log(`  [Day ${s.day}] → ${s.to}: ${s.msg}`));
    console.log('');
  }

  showTokens() {
    console.log(`\n  TOKENS: ALL ACTIVE TOKENS:`);
    console.log(`  ${'─'.repeat(60)}`);
    const active=Array.from(this.B.values()).filter(b=>!TERMINAL.has(b.st));
    if(!active.length){console.log('  None.');return;}
    active.forEach(b=>{
      const fn=this.F.get(b.fid).name;
      const mn=this.M.get(b.mid).name;
      console.log(`  ${b.tok.padEnd(16)} ${fn.padEnd(18)} ${mn.padEnd(16)} D${b.day} ${b.st}`);
    });
    console.log(`  ${'─'.repeat(60)}\n`);
  }
}

// ─── SEED ─────────────────────────────────────────────────────
function seed() {
  const e=new Engine();
  e.M.set('KNL',{mid:'KNL',name:'Karnal Mandi',    district:'Karnal', cap:8});
  e.M.set('NLK',{mid:'NLK',name:'Nilokheri Mandi',  district:'Karnal', cap:6});
  e.M.set('GHR',{mid:'GHR',name:'Gharaunda Mandi',  district:'Karnal', cap:5});

  [['F01','Ramesh Singh','9876500001','Dhanauri','Karnal',5],
   ['F02','Sukhdev Pal','9876500002','Dhanauri','Karnal',3],
   ['F03','Manjeet Kaur','9876500003','Bastli','Karnal',8],
   ['F04','Harpal Kumar','9876500004','Bastli','Karnal',2.5],
   ['F05','Balwinder Singh','9876500005','Gharaunda','Karnal',6],
   ['F06','Gurpreet Kaur','9876500006','Gharaunda','Karnal',4],
   ['F07','Jaswant Rao','9876500007','Nilokheri','Karnal',7],
   ['F08','Mohinder Pal','9876500008','Nilokheri','Karnal',3.5],
   ['F09','Darshan Singh','9876500009','Kunjpura','Karnal',10],
   ['F10','Prakash Chand','9876500010','Kunjpura','Karnal',2],
   ['F11','Satish Kumar','9876500011','Indri','Karnal',4.5],
   ['F12','Rani Devi','9876500012','Indri','Karnal',3],
   ['F13','Vikram Jat','9876500013','Assandh','Karnal',6.5],
   ['F14','Sunita Rani','9876500014','Assandh','Karnal',2],
   ['F15','Bhagwan Das','9876500015','Taraori','Karnal',5.5],
  ].forEach(([fid,name,phone,village,district,acres])=>
    e.F.set(fid,{fid,name,phone,village,district,acres}));
  return e;
}

// ─── INTERACTIVE MENU ─────────────────────────────────────────
async function main() {
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  const ask=(q)=>new Promise(r=>rl.question(q,r));

  const askMandi=async(label)=>{
    console.log('  Available Mandis:');
    for(const [mid,m] of e.M.entries()){
      const ds=e.ds(mid,e.day);
      const icon=ds.paused?'[PAUSED]':'[ACTIVE]';
      console.log(`    ${icon} ${mid} → ${m.name} (cap:${ds.cap}, booked:${ds.booked}, avail:${ds.avail})`);
    }
    return (await ask(label||'  Mandi (KNL/NLK/GHR): ')).trim().toUpperCase();
  };

  const e=seed();

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  MANDIFLOW: MANDI QUEUE ENGINE — Interactive Sandbox                ║
║  SIH 2026 | PS 26032 | DoCA                                ║
║                                                             ║
║  Pre-loaded: 3 Mandis (KNL, NLK, GHR) | 15 Farmers (F01-15)║
║  You control everything. Break it. Find the edge cases.     ║
╚══════════════════════════════════════════════════════════════╝
`);
  e.showAll();
  e.showFarmers();

  while(true) {
    console.log(`${'─'.repeat(62)}`);
    console.log(`  DAY DAY ${e.day}                         MANDI QUEUE ENGINE`);
    console.log(`${'─'.repeat(62)}`);
    console.log(`  ── FARMER ACTIONS ──              ── OPERATOR ACTIONS ──`);
    console.log(`  1.  Book Slot                     7.  Call Next in Queue`);
    console.log(`  2.  Cancel Booking                8.  Accept Crop (Weigh)`);
    console.log(`  3.  Check In at Gate              9.  Reject (Moisture Fail)`);
    console.log(`                                    10. Mark Payment as Paid`);
    console.log(`  ── MANDI CONTROLS ──              ── SIMULATION ──`);
    console.log(`  4.  Pause Mandi                   11. Advance to Next Day`);
    console.log(`  5.  Resume Mandi                  12. Set Bardana Stock`);
    console.log(`  6.  Process No-Shows              13. Set Storage %`);
    console.log(`  ── VIEWS ──                       ── BULK ──`);
    console.log(`  20. View Mandi Status             30. Book Multiple Farmers`);
    console.log(`  21. View All Mandis               31. Check In All Booked`);
    console.log(`  22. View Farmer                   32. Process Entire Queue`);
    console.log(`  23. View All Farmers`);
    console.log(`  24. View Slot Availability`);
    console.log(`  25. View Active Tokens`);
    console.log(`  26. View SMS Log`);
    console.log(`  0.  Exit`);
    console.log(`${'─'.repeat(62)}`);

    const c=(await ask('  > ')).trim();

    if(c==='0') { console.log('\n  Goodbye!\n'); rl.close(); return; }

    // ── BOOK ──
    else if(c==='1') {
      e.showFarmers();
      const fid=(await ask('  Farmer ID (e.g. F01): ')).trim().toUpperCase();
      const mid=await askMandi();
      e.showSlots(mid);
      const day=parseInt(await ask(`  Day [${e.day}]: `) || e.day);
      e.book(fid,mid,day,Crop.PADDY);
    }

    // ── CANCEL ──
    else if(c==='2') {
      e.showTokens();
      const tok=(await ask('  Token to cancel: ')).trim().toUpperCase();
      e.cancel(tok);
    }

    // ── CHECK IN ──
    else if(c==='3') {
      const booked=Array.from(e.B.values()).filter(b=>b.day===e.day&&b.st===Status.BOOKED);
      if(booked.length) {
        console.log(`\n  Tokens valid for check-in today (Day ${e.day}):`);
        booked.forEach(b=>console.log(`    ${b.tok}  ${e.F.get(b.fid).name}`));
      }
      const re=Array.from(e.B.values()).filter(b=>b.day===e.day&&b.st===Status.RE_INSPECTION);
      if(re.length) {
        console.log(`  Re-inspection tokens due today:`);
        re.forEach(b=>console.log(`    ${b.tok}  ${e.F.get(b.fid).name} (RE_INSPECTION)`));
      }
      const tok=(await ask('  Token: ')).trim().toUpperCase();
      e.checkin(tok);
    }

    // ── PAUSE ──
    else if(c==='4') {
      const mid=await askMandi();
      console.log('  Reasons: RAIN, NO_BAGS, STORAGE_FULL, POWER_CUT, OTHER');
      const r=(await ask('  Reason: ')).trim().toUpperCase()||'OTHER';
      e.pause(mid,r);
    }

    // ── RESUME ──
    else if(c==='5') {
      const mid=await askMandi();
      e.resume(mid);
    }

    // ── NO SHOWS ──
    else if(c==='6') {
      const mid=await askMandi();
      e.noShows(mid);
    }

    // ── CALL NEXT ──
    else if(c==='7') {
      const mid=await askMandi();
      e.callNext(mid);
    }

    // ── ACCEPT ──
    else if(c==='8') {
      const weighing=Array.from(e.B.values()).filter(b=>b.st===Status.WEIGHING);
      if(weighing.length) {
        console.log('  At weighing bridge:');
        weighing.forEach(b=>console.log(`    ${b.tok}  ${e.F.get(b.fid).name} (${b.crop})`));
      }
      const tok=(await ask('  Token: ')).trim().toUpperCase();
      const wt=parseFloat(await ask('  Weight (quintals): '));
      e.accept(tok,wt);
    }

    // ── REJECT MOISTURE ──
    else if(c==='9') {
      const weighing=Array.from(e.B.values()).filter(b=>b.st===Status.WEIGHING);
      if(weighing.length) {
        console.log('  At weighing bridge:');
        weighing.forEach(b=>{
          const lim=MLIMIT[b.crop]||17;
          console.log(`    ${b.tok}  ${e.F.get(b.fid).name} (${b.crop}, limit: ${lim}%)`);
        });
      }
      const tok=(await ask('  Token: ')).trim().toUpperCase();
      const m=parseFloat(await ask('  Moisture reading (%): '));
      e.reject(tok,m);
    }

    // ── MARK PAID ──
    else if(c==='10') {
      const pending=Array.from(e.B.values()).filter(b=>b.st===Status.PAYMENT_INITIATED);
      if(pending.length) {
        console.log('  Payments pending:');
        pending.forEach(b=>console.log(`    ${b.tok}  ${e.F.get(b.fid).name} ₹${b.amt.toLocaleString('en-IN')}`));
      }
      const tok=(await ask('  Token: ')).trim().toUpperCase();
      e.paid(tok);
    }

    // ── NEXT DAY ──
    else if(c==='11') { e.nextDay(); }

    // ── SET BARDANA ──
    else if(c==='12') {
      const mid=await askMandi();
      const day=parseInt(await ask(`  Day [${e.day}]: `) || e.day);
      const n=parseInt(await ask('  Set bags to: '));
      e.setBags(mid,day,n);
    }

    // ── SET STORAGE ──
    else if(c==='13') {
      const mid=await askMandi();
      const day=parseInt(await ask(`  Day [${e.day}]: `) || e.day);
      const pct=parseInt(await ask('  Storage % (0-100): '));
      e.setStorage(mid,day,pct);
    }

    // ── VIEWS ──
    else if(c==='20') {
      const mid=await askMandi();
      e.showMandi(mid);
    }
    else if(c==='21') { e.showAll(); }
    else if(c==='22') {
      const fid=(await ask('  Farmer ID: ')).trim().toUpperCase();
      e.showFarmer(fid);
    }
    else if(c==='23') { e.showFarmers(); }
    else if(c==='24') {
      const mid=await askMandi();
      e.showSlots(mid);
    }
    else if(c==='25') { e.showTokens(); }
    else if(c==='26') {
      const n=parseInt(await ask('  How many recent? [20]: ') || '20');
      e.showSMS(n);
    }

    // ── BULK: BOOK MULTIPLE ──
    else if(c==='30') {
      const mid=await askMandi();
      const day=parseInt(await ask(`  Day [${e.day}]: `) || e.day);
      const ids=(await ask('  Farmer IDs (comma-sep, e.g. F01,F02,F03): ')).trim().toUpperCase();
      ids.split(',').map(s=>s.trim()).filter(Boolean).forEach(fid=>
        e.book(fid,mid,day,Crop.PADDY));
    }

    // ── BULK: CHECK IN ALL BOOKED TODAY ──
    else if(c==='31') {
      const mid=await askMandi();
      const booked=Array.from(e.B.values()).filter(
        b=>b.mid===mid && b.day===e.day && (b.st===Status.BOOKED||b.st===Status.RE_INSPECTION));
      console.log(`  Checking in ${booked.length} farmer(s)...`);
      booked.forEach(b=>e.checkin(b.tok));
    }

    // ── BULK: PROCESS ENTIRE QUEUE ──
    else if(c==='32') {
      const mid=await askMandi();
      let processed=0;
      while(true) {
        const nxt=e.callNext(mid);
        if(!nxt) break;
        const wt=5+Math.floor(Math.random()*60); // random 5-65 quintals
        console.log(`  [Auto] Accepting ${e.F.get(nxt.fid).name}: ${wt} quintals`);
        e.accept(nxt.tok, wt);
        processed++;
      }
      console.log(`  Processed ${processed} farmer(s) total.`);
    }

    else {
      console.log('  [?] Invalid choice. Try again.');
    }
  }
}

main().catch(console.error);
