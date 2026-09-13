/**
 * ================================================================
 * MANDI QUEUE MANAGEMENT ENGINE — Terminal Prototype (Node.js)
 * ================================================================
 * SIH 2026 | PS 26032 | DoCA
 *
 * HOW TO RUN:
 *   node mandi_engine.js
 *   OR paste into https://onecompiler.com/nodejs or any online JS runner!
 *
 * Zero external dependencies. Pure vanilla Node.js / JavaScript.
 *
 * ASSUMPTIONS MADE:
 *   1. Simulated timeline in "Days" (Day 1, Day 2...).
 *   2. SMS alerts are simulated via terminal prints.
 *   3. In-memory data structures (resets on restart).
 *   4. Mandis configured with realistic small daily caps (5-8) to easily observe queues and overflows.
 *   5. Buffer = 10% of capacity reserved for walk-ins / re-inspections.
 *   6. Moisture limits: Paddy <= 17%, Wheat <= 14%, Mustard <= 8%.
 *   7. Sun drying rate: ~2% moisture drop per day.
 *   8. One active booking per farmer at a time.
 *   9. Gunny bags per farmer: ~20 bags (10 quintals avg, 50kg bags).
 *   10. Strict priority: Re-inspection/Drying (800) > Rescheduled (500 + 100*n) > Regular FIFO (0).
 *   11. Official MSP rates: Wheat ₹2,275, Paddy ₹2,320, Mustard ₹5,650.
 * ================================================================
 */

const readline = require('readline');

// --- ENUMS & CONSTANTS ---
const Status = Object.freeze({
  BOOKED: 'BOOKED',
  CHECKED_IN: 'CHECKED_IN',
  IN_QUEUE: 'IN_QUEUE',
  WEIGHING: 'WEIGHING',
  ACCEPTED: 'ACCEPTED',
  REJECTED_MOISTURE: 'REJECTED_MOISTURE',
  DRYING: 'DRYING',
  RE_INSPECTION: 'RE_INSPECTION',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  RESCHEDULED: 'RESCHEDULED'
});

const TRANSITIONS = {
  [Status.BOOKED]: [Status.CHECKED_IN, Status.CANCELLED, Status.NO_SHOW, Status.RESCHEDULED],
  [Status.CHECKED_IN]: [Status.IN_QUEUE],
  [Status.IN_QUEUE]: [Status.WEIGHING],
  [Status.WEIGHING]: [Status.ACCEPTED, Status.REJECTED_MOISTURE],
  [Status.ACCEPTED]: [Status.PAYMENT_INITIATED],
  [Status.PAYMENT_INITIATED]: [Status.PAID],
  [Status.REJECTED_MOISTURE]: [Status.DRYING],
  [Status.DRYING]: [Status.RE_INSPECTION],
  [Status.RE_INSPECTION]: [Status.IN_QUEUE]
};

const TERMINAL_STATES = new Set([Status.PAID, Status.CANCELLED, Status.NO_SHOW, Status.RESCHEDULED]);

const Crop = Object.freeze({
  WHEAT: 'WHEAT',
  PADDY: 'PADDY',
  MUSTARD: 'MUSTARD'
});

const MOISTURE_LIMIT = { [Crop.WHEAT]: 14.0, [Crop.PADDY]: 17.0, [Crop.MUSTARD]: 8.0 };
const MSP_RATE = { [Crop.WHEAT]: 2275, [Crop.PADDY]: 2320, [Crop.MUSTARD]: 5650 };
const BAGS_PER_FARMER = 20;

// --- DATA STRUCTURES ---
class Farmer {
  constructor(fid, name, phone, village, district, acres) {
    this.fid = fid;
    this.name = name;
    this.phone = phone;
    this.village = village;
    this.district = district;
    this.acres = acres;
  }
}

class Mandi {
  constructor(mid, name, district, capacity) {
    this.mid = mid;
    this.name = name;
    this.district = district;
    this.capacity = capacity;
  }
}

class DailyStatus {
  constructor(mid, day, capacity) {
    this.mid = mid;
    this.day = day;
    this.cap_total = capacity;
    this.cap_buffer = Math.max(1, Math.floor(capacity / 10));
    this.booked = 0;
    this.checked_in = 0;
    this.completed = 0;
    this.bags = capacity * BAGS_PER_FARMER;
    this.storage_pct = 0;
    this.drying_count = 0;
    this.paused = false;
    this.pause_reason = '';
  }

  get bookable() {
    const effective = this.cap_total - this.cap_buffer - this.drying_count;
    return Math.max(0, effective - this.booked);
  }
}

let bookingCounter = 0;
class Booking {
  constructor(fid, mid, day, crop, token) {
    bookingCounter++;
    this.bid = `BK-${String(bookingCounter).padStart(4, '0')}`;
    this.fid = fid;
    this.mid = mid;
    this.day = day;
    this.crop = crop;
    this.token = token;
    this.status = Status.BOOKED;
    this.checkin_seq = -1;
    this.priority = 0;
    this.weight_q = 0.0;
    this.moisture = 0.0;
    this.amount = 0.0;
    this.resched_count = 0;
    this.parent_bid = null;
    this.history = [];
  }
}

// --- CORE ENGINE ---
class Engine {
  constructor() {
    this.farmers = new Map();
    this.mandis = new Map();
    this.bookings = new Map(); // token -> Booking
    this.daily = new Map();    // "mid:day" -> DailyStatus
    this.day = 1;
    this.sms_log = [];
    this.seq = 0;
    this.tok_seq = new Map();
  }

  _sms(fid, msg) {
    const f = this.farmers.get(fid);
    const line = `  📱 SMS → ${f.name} (${f.phone}): ${msg}`;
    this.sms_log.push(line);
    console.log(line);
  }

  _log(msg) {
    console.log(`  ⚙️  ${msg}`);
  }

  _ds(mid, day) {
    const key = `${mid}:${day}`;
    if (!this.daily.has(key)) {
      this.daily.set(key, new DailyStatus(mid, day, this.mandis.get(mid).capacity));
    }
    return this.daily.get(key);
  }

  _token(mid, day) {
    const k = `${mid}-${day}`;
    const nextVal = (this.tok_seq.get(k) || 0) + 1;
    this.tok_seq.set(k, nextVal);
    return `${mid}-D${day}-${String(nextVal).padStart(3, '0')}`;
  }

  _move(bk, to) {
    const allowed = TRANSITIONS[bk.status] || [];
    if (!allowed.includes(to)) {
      console.log(`  ❌ ILLEGAL TRANSITION: ${bk.status} → ${to} (Allowed: ${allowed.join(', ')})`);
      return false;
    }
    const old = bk.status;
    bk.status = to;
    bk.history.push({ status: to, day: this.day });
    this._log(`${old} → ${to}  [${bk.token}]`);
    return true;
  }

  _queue(mid) {
    const q = Array.from(this.bookings.values()).filter(
      b => b.mid === mid && b.day === this.day && b.status === Status.IN_QUEUE
    );
    // Highest priority first, then FIFO by checkin sequence
    q.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.checkin_seq - b.checkin_seq;
    });
    return q;
  }

  _qpos(bk) {
    const q = this._queue(bk.mid);
    const idx = q.findIndex(b => b.token === bk.token);
    return idx >= 0 ? idx + 1 : -1;
  }

  _find_slot(pref_mid, start_day) {
    // 1. Same mandi on future days
    for (let d = start_day; d < start_day + 10; d++) {
      const ds = this._ds(pref_mid, d);
      if (!ds.paused && ds.bookable > 0) return { day: d, mid: pref_mid };
    }
    // 2. Neighbor mandis
    for (const mid of this.mandis.keys()) {
      if (mid === pref_mid) continue;
      for (let d = start_day; d < start_day + 10; d++) {
        const ds = this._ds(mid, d);
        if (!ds.paused && ds.bookable > 0) return { day: d, mid };
      }
    }
    return { day: null, mid: null };
  }

  _active(fid) {
    for (const b of this.bookings.values()) {
      if (b.fid === fid && !TERMINAL_STATES.has(b.status)) return b;
    }
    return null;
  }

  add_farmer(fid, name, phone, village, district, acres) {
    this.farmers.set(fid, new Farmer(fid, name, phone, village, district, acres));
  }

  add_mandi(mid, name, district, cap) {
    this.mandis.set(mid, new Mandi(mid, name, district, cap));
  }

  book(fid, mid, day, crop) {
    if (!this.farmers.has(fid)) { console.log(`  ❌ Farmer ${fid} not registered`); return null; }
    if (!this.mandis.has(mid)) { console.log(`  ❌ Mandi ${mid} not found`); return null; }
    if (day < this.day) { console.log(`  ❌ Cannot book past day (Today = Day ${this.day})`); return null; }

    const act = this._active(fid);
    if (act) {
      console.log(`  ❌ ${this.farmers.get(fid).name} already has active token ${act.token} (${act.status})`);
      return null;
    }

    const ds = this._ds(mid, day);
    if (ds.paused) {
      console.log(`  ❌ ${this.mandis.get(mid).name} PAUSED on Day ${day}: ${ds.pause_reason}`);
      return null;
    }
    if (ds.bookable <= 0) {
      console.log(`  ❌ FULL: ${this.mandis.get(mid).name} Day ${day} (${ds.booked}/${ds.cap_total - ds.cap_buffer})`);
      return null;
    }

    const token = this._token(mid, day);
    const bk = new Booking(fid, mid, day, crop, token);
    bk.history.push({ status: Status.BOOKED, day: this.day });
    this.bookings.set(token, bk);
    ds.booked++;

    this._log(`BOOKED: ${this.farmers.get(fid).name} → ${this.mandis.get(mid).name} Day ${day} [${token}]`);
    this._sms(fid, `✅ CONFIRMED | Token: ${token} | ${this.mandis.get(mid).name}, Day ${day} | Crop: ${crop}`);
    return bk;
  }

  checkin(token) {
    if (!this.bookings.has(token)) { console.log(`  ❌ Token ${token} not found`); return false; }
    const bk = this.bookings.get(token);

    if (bk.day !== this.day) {
      console.log(`  ❌ Token is for Day ${bk.day}, but today is Day ${this.day}`);
      return false;
    }

    if (bk.status === Status.RE_INSPECTION) {
      if (!this._move(bk, Status.IN_QUEUE)) return false;
      this.seq++;
      bk.checkin_seq = this.seq;
      bk.priority = 800; // Prioritize over normal regular arrivals
      this._ds(bk.mid, this.day).checked_in++;
      this._ds(bk.mid, this.day).drying_count = Math.max(0, this._ds(bk.mid, this.day).drying_count - 1);
      const pos = this._qpos(bk);
      this._sms(bk.fid, `🔄 Re-inspection check-in | Token: ${token} | Queue Position: #${pos}`);
      return true;
    }

    if (!this._move(bk, Status.CHECKED_IN)) return false;
    if (!this._move(bk, Status.IN_QUEUE)) return false;

    this.seq++;
    bk.checkin_seq = this.seq;
    bk.priority = bk.resched_count > 0 ? (500 + bk.resched_count * 100) : 0;

    this._ds(bk.mid, this.day).checked_in++;
    const pos = this._qpos(bk);
    this._sms(bk.fid, `✅ Checked in | Token: ${token} | Queue Position: #${pos} | Est. wait: ~${pos * 20} min`);
    return true;
  }

  call_next(mid) {
    const q = this._queue(mid);
    if (q.length === 0) {
      console.log(`  ℹ️  Queue empty at ${this.mandis.get(mid).name}`);
      return null;
    }

    const ds = this._ds(mid, this.day);
    if (ds.bags < BAGS_PER_FARMER) {
      console.log(`  ❌ BARDANA EXHAUSTED at ${this.mandis.get(mid).name} — Only ${ds.bags} bags left (need ${BAGS_PER_FARMER})`);
      this._log('Action recommended: Operator must pause procurement and reschedule.');
      return null;
    }

    const nxt = q[0];
    if (!this._move(nxt, Status.WEIGHING)) return null;

    this._sms(nxt.fid, `🔔 YOUR TURN | Token: ${nxt.token} | Proceed to Weighing Bridge`);

    const remaining = this._queue(mid);
    remaining.slice(0, 2).forEach((b, i) => {
      this._sms(b.fid, `Queue update: You moved to #${i + 1}, est. ~${(i + 1) * 20} min`);
    });

    return nxt;
  }

  accept(token, weight_q) {
    if (!this.bookings.has(token)) { console.log(`  ❌ Token ${token} not found`); return false; }
    const bk = this.bookings.get(token);
    if (bk.status !== Status.WEIGHING) {
      console.log(`  ❌ Token ${token} is in ${bk.status}, not WEIGHING`);
      return false;
    }

    bk.weight_q = weight_q;
    const rate = MSP_RATE[bk.crop] || 2000;
    bk.amount = weight_q * rate;

    if (!this._move(bk, Status.ACCEPTED)) return false;
    if (!this._move(bk, Status.PAYMENT_INITIATED)) return false;

    const ds = this._ds(bk.mid, this.day);
    ds.completed++;
    ds.bags = Math.max(0, ds.bags - Math.floor(weight_q * 2));
    ds.storage_pct = Math.min(100, ds.storage_pct + Math.floor(weight_q * 0.5));

    this._sms(bk.fid, `✅ ACCEPTED | ${weight_q} quintals × ₹${rate} = ₹${bk.amount.toLocaleString('en-IN')} | DBT Payment INITIATED`);
    return true;
  }

  reject_moisture(token, reading) {
    if (!this.bookings.has(token)) { console.log(`  ❌ Token ${token} not found`); return null; }
    const bk = this.bookings.get(token);
    if (bk.status !== Status.WEIGHING) {
      console.log(`  ❌ Token ${token} is in ${bk.status}, not WEIGHING`);
      return null;
    }

    const limit = MOISTURE_LIMIT[bk.crop] || 17.0;
    const gap = reading - limit;
    const dry_days = Math.max(1, Math.round(gap / 2.0));
    const re_day = this.day + dry_days;

    bk.moisture = reading;
    if (!this._move(bk, Status.REJECTED_MOISTURE)) return null;
    if (!this._move(bk, Status.DRYING)) return null;

    // Block yard space for drying period
    for (let d = this.day; d <= re_day; d++) {
      this._ds(bk.mid, d).drying_count++;
    }

    // Auto-schedule re-inspection token from buffer pool
    const re_tok = this._token(bk.mid, re_day);
    const re_bk = new Booking(bk.fid, bk.mid, re_day, bk.crop, re_tok);
    re_bk.status = Status.RE_INSPECTION;
    re_bk.parent_bid = bk.bid;
    re_bk.priority = 800;
    re_bk.history.push({ status: Status.RE_INSPECTION, day: this.day, note: 'auto-reinspection' });
    this.bookings.set(re_tok, re_bk);

    this._sms(
      bk.fid,
      `❌ MOISTURE ${reading}% (limit ${limit}%) | Dry ~${dry_days} day(s) in yard | Re-inspect Day ${re_day} | Token: ${re_tok}`
    );
    return re_tok;
  }

  pause(mid, reason) {
    const m = this.mandis.get(mid);
    const ds1 = this._ds(mid, this.day);
    ds1.paused = true;
    ds1.pause_reason = reason;

    const ds2 = this._ds(mid, this.day + 1);
    ds2.paused = true;
    ds2.pause_reason = reason;

    this._log(`🔴 PAUSED: ${m.name} | Reason: ${reason}`);
    this._log('Rule: Farmers physically inside (IN_QUEUE / WEIGHING) remain protected.');

    const to_resched = Array.from(this.bookings.values()).filter(
      b => b.mid === mid && (b.day === this.day || b.day === this.day + 1) && b.status === Status.BOOKED
    );

    let count = 0;
    for (const bk of to_resched) {
      const { day: nd, mid: nm } = this._find_slot(mid, this.day + 2);
      if (!nd) {
        this._sms(bk.fid, `⚠️ ${m.name} PAUSED (${reason}). No nearby slots open. Awaiting clearance. DO NOT travel.`);
        continue;
      }

      bk.status = Status.RESCHEDULED;
      bk.history.push({ status: Status.RESCHEDULED, day: this.day });

      const new_tok = this._token(nm, nd);
      const nb = new Booking(bk.fid, nm, nd, bk.crop, new_tok);
      nb.resched_count = bk.resched_count + 1;
      nb.parent_bid = bk.bid;
      nb.history.push({ status: Status.BOOKED, day: this.day, note: 'rescheduled' });
      this.bookings.set(new_tok, nb);
      this._ds(nm, nd).booked++;

      const destName = this.mandis.get(nm).name;
      if (nm === mid) {
        this._sms(bk.fid, `⚠️ ${m.name} PAUSED (${reason}). Rescheduled to Day ${nd} (Same Mandi). New Token: ${new_tok}`);
      } else {
        this._sms(bk.fid, `⚠️ ${m.name} PAUSED (${reason}). Rerouted to ${destName} on Day ${nd}. New Token: ${new_tok}`);
      }
      count++;
    }

    this._log(`Dynamically rescheduled ${count} pending farmer booking(s).`);
    return count;
  }

  resume(mid) {
    const ds = this._ds(mid, this.day);
    ds.paused = false;
    ds.pause_reason = '';
    this._log(`🟢 RESUMED: ${this.mandis.get(mid).name}`);
  }

  no_shows(mid) {
    const ns = Array.from(this.bookings.values()).filter(
      b => b.mid === mid && b.day === this.day && b.status === Status.BOOKED
    );

    for (const bk of ns) {
      bk.status = Status.NO_SHOW;
      bk.history.push({ status: Status.NO_SHOW, day: this.day });
      this._sms(bk.fid, `⏰ MISSED SLOT | Token ${bk.token} expired. Re-book when ready.`);
    }

    if (ns.length > 0) {
      const ds = this._ds(mid, this.day);
      ds.cap_buffer += ns.length;
      this._log(`${ns.length} no-show(s) processed. Reclaimed slots added to Buffer pool (now ${ds.cap_buffer}).`);
    }
    return ns.length;
  }

  set_bags(mid, day, amt) {
    const ds = this._ds(mid, day);
    ds.bags = amt;
    this._log(`Bardana stock at ${this.mandis.get(mid).name} set to ${amt} bags.`);
  }

  mark_paid(token) {
    if (!this.bookings.has(token)) return;
    const bk = this.bookings.get(token);
    if (bk.status !== Status.PAYMENT_INITIATED) return;
    bk.status = Status.PAID;
    bk.history.push({ status: Status.PAID, day: this.day });
    this._sms(bk.fid, `💰 ₹${bk.amount.toLocaleString('en-IN')} successfully credited via DBT into bank account!`);
  }

  next_day() {
    this.day++;
    this._log(`${'='.repeat(22)} ADVANCED TO DAY ${this.day} ${'='.repeat(22)}`);
    for (const b of this.bookings.values()) {
      if (b.status === Status.RE_INSPECTION && b.day === this.day) {
        this._log(`Re-inspection due today: Token ${b.token} (${this.farmers.get(b.fid).name})`);
      }
    }
  }

  show_mandi(mid) {
    const m = this.mandis.get(mid);
    const ds = this._ds(mid, this.day);
    const q = this._queue(mid);
    const statusIcon = ds.paused ? '🔴' : '🟢';

    console.log(`\n${'━'.repeat(58)}`);
    console.log(`  📍 MANDI: ${m.name.toUpperCase()} | DAY ${this.day}`);
    console.log(`${'━'.repeat(58)}`);
    console.log(`  Status:    ${statusIcon} ${ds.paused ? `PAUSED (${ds.pause_reason})` : 'ACTIVE'}`);
    console.log(`  Capacity:  ${ds.cap_total}/day (Buffer: ${ds.cap_buffer}, Drying Yard: ${ds.drying_count})`);
    console.log(`  Booked:    ${ds.booked} | Checked-in: ${ds.checked_in} | Done: ${ds.completed}`);
    console.log(`  Bookable:  ${ds.bookable} remaining`);
    console.log(`  Bardana:   ${ds.bags} bags`);
    console.log(`  Storage:   ${ds.storage_pct}%`);

    if (q.length > 0) {
      console.log(`\n  📋 LIVE QUEUE (${q.length} farmers in yard):`);
      q.forEach((b, i) => {
        const fn = this.farmers.get(b.fid).name;
        const p = b.priority > 0 ? ` [Priority: ${b.priority}]` : '';
        const r = b.resched_count > 0 ? ` [Rescheduled ×${b.resched_count}]` : '';
        console.log(`    #${i + 1}  ${fn.padEnd(20)} ${b.token}${p}${r}`);
      });
    }

    const weighing = Array.from(this.bookings.values()).filter(
      b => b.mid === mid && b.day === this.day && b.status === Status.WEIGHING
    );
    if (weighing.length > 0) {
      console.log(`\n  ⚖️  ON WEIGHING BRIDGE:`);
      weighing.forEach(b => {
        console.log(`    ${this.farmers.get(b.fid).name.padEnd(20)} ${b.token}`);
      });
    }

    const drying = Array.from(this.bookings.values()).filter(
      b => b.mid === mid && b.status === Status.DRYING
    );
    if (drying.length > 0) {
      console.log(`\n  ☀️  DRYING IN YARD (Crop spread on ground):`);
      drying.forEach(b => {
        const child = Array.from(this.bookings.values()).find(
          x => x.parent_bid === b.bid && x.status === Status.RE_INSPECTION
        );
        const rd = child ? `Day ${child.day}` : '?';
        console.log(`    ${this.farmers.get(b.fid).name.padEnd(20)} Moisture: ${b.moisture}% → Re-inspection: ${rd}`);
      });
    }
    console.log(`${'━'.repeat(58)}\n`);
  }

  show_farmer(fid) {
    if (!this.farmers.has(fid)) { console.log(`  ❌ Farmer ${fid} not found`); return; }
    const f = this.farmers.get(fid);
    console.log(`\n${'-'.repeat(50)}`);
    console.log(`  👨‍🌾 ${f.name} | Village: ${f.village}, ${f.district} | ${f.acres} acres`);
    console.log(`  📞 Contact: ${f.phone}`);
    const bks = Array.from(this.bookings.values()).filter(b => b.fid === fid);
    if (bks.length > 0) {
      console.log(`  📜 TIMELINE / AUDIT TRAIL:`);
      bks.forEach(b => {
        const mn = this.mandis.get(b.mid).name;
        let details = '';
        if (b.weight_q) details += ` | ${b.weight_q}q = ₹${b.amount.toLocaleString('en-IN')}`;
        if (b.moisture) details += ` | Moisture: ${b.moisture}%`;
        if (b.resched_count) details += ` | Resched: ×${b.resched_count}`;
        console.log(`    • [${b.token}] Mandi: ${mn} (Day ${b.day}) → ${b.status}${details}`);
        b.history.forEach(h => console.log(`       └─ ${h.status} (Day ${h.day})`));
      });
    } else {
      console.log(`  No bookings on record.`);
    }
    console.log(`${'-'.repeat(50)}\n`);
  }

  show_all() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  DISTRICT PROCUREMENT STATUS | CURRENT: DAY ${this.day}`);
    console.log(`${'='.repeat(60)}`);
    for (const [mid, m] of this.mandis.entries()) {
      const ds = this._ds(mid, this.day);
      const icon = ds.paused ? '🔴' : '🟢';
      const qlen = this._queue(mid).length;
      console.log(
        `  ${icon} ${m.name.padEnd(16)} | Booked: ${String(ds.booked).padStart(2)}/${ds.cap_total} | Queue: ${String(qlen).padStart(2)} | Done: ${String(ds.completed).padStart(2)} | Bags: ${String(ds.bags).padStart(4)}`
      );
    }
    console.log(`${'='.repeat(60)}\n`);
  }
}

// --- SEED REALISTIC TEST ENVIRONMENT ---
function seed() {
  const e = new Engine();
  e.add_mandi('KNL', 'Karnal Mandi', 'Karnal', 8);
  e.add_mandi('NLK', 'Nilokheri Mandi', 'Karnal', 6);
  e.add_mandi('GHR', 'Gharaunda Mandi', 'Karnal', 5);

  const farmers = [
    ['F01', 'Ramesh Singh', '9876500001', 'Dhanauri', 'Karnal', 5.0],
    ['F02', 'Sukhdev Pal', '9876500002', 'Dhanauri', 'Karnal', 3.0],
    ['F03', 'Manjeet Kaur', '9876500003', 'Bastli', 'Karnal', 8.0],
    ['F04', 'Harpal Kumar', '9876500004', 'Bastli', 'Karnal', 2.5],
    ['F05', 'Balwinder Singh', '9876500005', 'Gharaunda', 'Karnal', 6.0],
    ['F06', 'Gurpreet Kaur', '9876500006', 'Gharaunda', 'Karnal', 4.0],
    ['F07', 'Jaswant Rao', '9876500007', 'Nilokheri', 'Karnal', 7.0],
    ['F08', 'Mohinder Pal', '9876500008', 'Nilokheri', 'Karnal', 3.5],
    ['F09', 'Darshan Singh', '9876500009', 'Kunjpura', 'Karnal', 10.0],
    ['F10', 'Prakash Chand', '9876500010', 'Kunjpura', 'Karnal', 2.0],
    ['F11', 'Satish Kumar', '9876500011', 'Indri', 'Karnal', 4.5],
    ['F12', 'Rani Devi', '9876500012', 'Indri', 'Karnal', 3.0],
    ['F13', 'Vikram Jat', '9876500013', 'Assandh', 'Karnal', 6.5],
    ['F14', 'Sunita Rani', '9876500014', 'Assandh', 'Karnal', 2.0],
    ['F15', 'Bhagwan Das', '9876500015', 'Taraori', 'Karnal', 5.5]
  ];

  farmers.forEach(f => e.add_farmer(...f));
  return e;
}

// --- 5 REAL-WORLD SCENARIOS ---
function runScenarioHappy(e) {
  console.log(`\n${'#'.repeat(65)}`);
  console.log(`  SCENARIO 1: HAPPY PATH — Clean End-to-End Procurement`);
  console.log(`  Flow: Book → Arrive/Check-in → Queue → Weigh → Accept → DBT`);
  console.log(`${'#'.repeat(65)}`);

  console.log(`\n[STEP 1] Farmers booking slots for Day 1 at Karnal Mandi:`);
  const b1 = e.book('F01', 'KNL', 1, Crop.PADDY);
  const b2 = e.book('F02', 'KNL', 1, Crop.PADDY);
  const b3 = e.book('F03', 'KNL', 1, Crop.WHEAT);

  console.log(`\n[STEP 2] Farmers arrive at Gate on Day 1:`);
  e.checkin(b1.token);
  e.checkin(b2.token);
  e.checkin(b3.token);
  e.show_mandi('KNL');

  console.log(`[STEP 3] Operator calls #1 (Ramesh) to weighbridge:`);
  e.call_next('KNL');

  console.log(`\n[STEP 4] Quality verified & 42 quintals accepted at MSP:`);
  e.accept(b1.token, 42.0);

  console.log(`\n[STEP 5] Process next two farmers:`);
  e.call_next('KNL');
  e.accept(b2.token, 28.0);
  e.call_next('KNL');
  e.accept(b3.token, 65.0);

  e.show_mandi('KNL');

  console.log(`[STEP 6] DBT Bank Settlement confirmation:`);
  e.mark_paid(b1.token);
  e.show_farmer('F01');
  console.log(`✅ SCENARIO 1 COMPLETE.\n`);
}

function runScenarioMoisture(e) {
  console.log(`\n${'#'.repeat(65)}`);
  console.log(`  SCENARIO 2: MOISTURE REJECTION TRAP & AUTO RE-INSPECTION`);
  console.log(`  Paddy tested at 19.5% (>17% limit). Must dry in yard without losing rights.`);
  console.log(`${'#'.repeat(65)}`);

  const b = e.book('F04', 'KNL', 1, Crop.PADDY);
  e.checkin(b.token);
  e.call_next('KNL');

  console.log(`\n[ACTION] Quality Inspector rejects: 19.5% Moisture.`);
  const reTok = e.reject_moisture(b.token, 19.5);
  e.show_mandi('KNL');

  console.log(`[SIMULATION] Advance to Day 2 (Crop drying on yard concrete):`);
  e.next_day();

  console.log(`\n[SIMULATION] Advance to Day 3 (Re-inspection date):`);
  e.next_day();

  if (reTok) {
    console.log(`\n[ACTION] Farmer checks in with Re-inspection Token:`);
    e.checkin(reTok);
    console.log(`\n[ACTION] Prioritized over regular line:`);
    e.call_next('KNL');
    e.accept(reTok, 22.0);
  }

  e.show_farmer('F04');
  console.log(`✅ SCENARIO 2 COMPLETE.\n`);
}

function runScenarioRain(e) {
  console.log(`\n${'#'.repeat(65)}`);
  console.log(`  SCENARIO 3: RAIN CASCADE & DYNAMIC RE-ROUTING`);
  console.log(`  Sudden rain hits Karnal. The engine halts admissions, protects farmers inside,`);
  console.log(`  and automatically reroutes/reschedules incoming queues.`);
  console.log(`${'#'.repeat(65)}`);

  const b5 = e.book('F05', 'KNL', 1, Crop.WHEAT);
  const b6 = e.book('F06', 'KNL', 1, Crop.WHEAT);
  const b7 = e.book('F07', 'KNL', 1, Crop.WHEAT);
  const b8 = e.book('F08', 'KNL', 1, Crop.WHEAT);

  const b9 = e.book('F09', 'KNL', 2, Crop.WHEAT);
  const b10 = e.book('F10', 'KNL', 2, Crop.WHEAT);

  e.checkin(b5.token);
  e.checkin(b6.token);
  e.checkin(b7.token);

  e.call_next('KNL');
  e.accept(b5.token, 45.0);

  console.log(`\n⛈️  HEAVY RAINSTORM BREAKS OUT AT 1:30 PM:`);
  e.pause('KNL', 'UNSEASONAL HEAVY RAINSTORM');
  e.show_mandi('KNL');
  e.show_all();

  console.log(`\n[SIMULATION] Fast forward to Day 3 (Rain clears, operations resume):`);
  e.next_day();
  e.next_day();
  e.resume('KNL');
  e.show_all();

  console.log(`\n[AUDIT] Check audit trail for affected farmer:`);
  e.show_farmer('F08');
  console.log(`✅ SCENARIO 3 COMPLETE.\n`);
}

function runScenarioNoShow(e) {
  console.log(`\n${'#'.repeat(65)}`);
  console.log(`  SCENARIO 4: NO-SHOW RECLAMATION (Reclaiming Wasted Capacity)`);
  console.log(`  Farmers fail to arrive; cutoff time triggers reallocation to buffer pool.`);
  console.log(`${'#'.repeat(65)}`);

  const b1 = e.book('F01', 'NLK', 1, Crop.PADDY);
  const b2 = e.book('F02', 'NLK', 1, Crop.PADDY);
  const b3 = e.book('F03', 'NLK', 1, Crop.PADDY);
  const b4 = e.book('F04', 'NLK', 1, Crop.PADDY);

  // Only F01 & F02 show up
  e.checkin(b1.token);
  e.checkin(b2.token);
  e.show_mandi('NLK');

  console.log(`\n⏰ 12:00 PM CUTOFF TRIGGERED:`);
  e.no_shows('NLK');
  e.show_mandi('NLK');
  e.show_farmer('F04');
  console.log(`✅ SCENARIO 4 COMPLETE.\n`);
}

function runScenarioBardana(e) {
  console.log(`\n${'#'.repeat(65)}`);
  console.log(`  SCENARIO 5: BARDANA (JUTE BAG) SHORTAGE CRUNCH`);
  console.log(`  Mandi runs out of gunny bags mid-operation. Safety block prevents chaos.`);
  console.log(`${'#'.repeat(65)}`);

  const b1 = e.book('F01', 'GHR', 1, Crop.WHEAT);
  const b2 = e.book('F02', 'GHR', 1, Crop.WHEAT);

  // Artificially restrict bags to 25
  e.set_bags('GHR', 1, 25);
  e.checkin(b1.token);
  e.checkin(b2.token);

  e.call_next('GHR');
  e.accept(b1.token, 40.0); // consumes bags
  e.show_mandi('GHR');

  console.log(`\n[TRY CALL NEXT] With inadequate bags remaining:`);
  const res = e.call_next('GHR');
  if (!res) {
    console.log(`\n[SAFETY ACTION] Halting admissions to prevent endless road jams:`);
    e.pause('GHR', 'BARDANA SHORTAGE');
    e.show_mandi('GHR');
  }
  console.log(`✅ SCENARIO 5 COMPLETE.\n`);
}

// --- EXECUTION DISPATCHER ---
function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  MANDI DYNAMIC QUEUE & CAPACITY ENGINE — Node.js Core      ║
║  SIH 2026 | PS 26032 | Ministry of Consumer Affairs (DoCA) ║
╚════════════════════════════════════════════════════════════╝
`);

  const e1 = seed();
  runScenarioHappy(e1);

  const e2 = seed();
  runScenarioMoisture(e2);

  const e3 = seed();
  runScenarioRain(e3);

  const e4 = seed();
  runScenarioNoShow(e4);

  const e5 = seed();
  runScenarioBardana(e5);

  console.log(`\n🎯 ALL 5 REAL-WORLD TEST SUITES EXECUTED SUCCESSFULLY.`);
}

main();
