"""
================================================================
MANDI QUEUE MANAGEMENT ENGINE — Terminal Prototype
================================================================
SIH 2026 | PS 26032
Ministry of Consumer Affairs, Food & Public Distribution (DoCA)

HOW TO RUN:
  python mandi_engine.py

REQUIREMENTS:
  Python 3.7+ | Zero external libraries

ASSUMPTIONS (clearly stated):
  1. Time is simulated as Day 1, Day 2... You advance manually.
  2. SMS = printed to console (no real gateway).
  3. All data is in-memory (resets on restart).
  4. 3 mandis pre-configured with SMALL capacity (5-8/day)
     so overflow is visible quickly in the demo.
  5. Buffer = 10% of capacity, for walk-ins + re-inspections.
  6. Moisture limits: Paddy <= 17%, Wheat <= 14%, Mustard <= 8%.
  7. Drying rate: ~2% moisture drop per day of sun-drying.
  8. One active booking per farmer at a time.
  9. Bags per farmer: ~20 (avg 10 quintals, 1 bag = 50 kg).
  10. Priority order: carry-over/re-inspection (800) >
      rescheduled (500 + 100*count) > regular (0, FIFO).
  11. MSP rates used: Wheat ₹2275, Paddy ₹2320, Mustard ₹5650.
  12. No-show cutoff is triggered manually (real system = timed).
================================================================
"""

from enum import Enum
from typing import Dict, List, Optional, Tuple
from collections import defaultdict


# ==============================================================
# ENUMS & CONSTANTS
# ==============================================================

class Status(Enum):
    BOOKED              = "BOOKED"
    CHECKED_IN          = "CHECKED_IN"
    IN_QUEUE            = "IN_QUEUE"
    WEIGHING            = "WEIGHING"
    ACCEPTED            = "ACCEPTED"
    REJECTED_MOISTURE   = "REJECTED_MOISTURE"
    DRYING              = "DRYING"
    RE_INSPECTION       = "RE_INSPECTION"
    PAYMENT_INITIATED   = "PAYMENT_INITIATED"
    PAID                = "PAID"
    CANCELLED           = "CANCELLED"
    NO_SHOW             = "NO_SHOW"
    RESCHEDULED         = "RESCHEDULED"

# Hard-coded legal transitions — anything else is rejected
TRANSITIONS = {
    Status.BOOKED:            [Status.CHECKED_IN, Status.CANCELLED,
                               Status.NO_SHOW, Status.RESCHEDULED],
    Status.CHECKED_IN:        [Status.IN_QUEUE],
    Status.IN_QUEUE:          [Status.WEIGHING],
    Status.WEIGHING:          [Status.ACCEPTED, Status.REJECTED_MOISTURE],
    Status.ACCEPTED:          [Status.PAYMENT_INITIATED],
    Status.PAYMENT_INITIATED: [Status.PAID],
    Status.REJECTED_MOISTURE: [Status.DRYING],
    Status.DRYING:            [Status.RE_INSPECTION],
    Status.RE_INSPECTION:     [Status.IN_QUEUE],
}

TERMINAL_STATES = {Status.PAID, Status.CANCELLED,
                   Status.NO_SHOW, Status.RESCHEDULED}

class Crop(Enum):
    WHEAT   = "WHEAT"
    PADDY   = "PADDY"
    MUSTARD = "MUSTARD"

MOISTURE_LIMIT = {Crop.WHEAT: 14.0, Crop.PADDY: 17.0, Crop.MUSTARD: 8.0}
MSP_RATE       = {Crop.WHEAT: 2275,  Crop.PADDY: 2320,  Crop.MUSTARD: 5650}
BAGS_PER_FARMER = 20


# ==============================================================
# DATA MODELS  (plain classes — no library needed)
# ==============================================================

class Farmer:
    def __init__(self, fid, name, phone, village, district, acres):
        self.fid      = fid
        self.name     = name
        self.phone    = phone
        self.village  = village
        self.district = district
        self.acres    = acres

class Mandi:
    def __init__(self, mid, name, district, capacity):
        self.mid      = mid
        self.name     = name
        self.district = district
        self.capacity = capacity          # max farmers / day

class DailyStatus:
    """One row per mandi per day — the heartbeat of capacity control."""
    def __init__(self, mid, day, capacity):
        self.mid             = mid
        self.day             = day
        self.cap_total       = capacity
        self.cap_buffer      = max(1, capacity // 10)
        self.booked          = 0
        self.checked_in      = 0
        self.completed       = 0
        self.bags            = capacity * BAGS_PER_FARMER
        self.storage_pct     = 0
        self.drying_count    = 0
        self.paused          = False
        self.pause_reason    = ""

    @property
    def bookable(self):
        """Slots a farmer can actually book right now."""
        eff = self.cap_total - self.cap_buffer - self.drying_count
        return max(0, eff - self.booked)

class Booking:
    _counter = 0

    def __init__(self, fid, mid, day, crop, token):
        Booking._counter += 1
        self.bid             = f"BK-{Booking._counter:04d}"
        self.fid             = fid
        self.mid             = mid
        self.day             = day
        self.crop            = crop
        self.token           = token
        self.status          = Status.BOOKED
        self.checkin_seq     = -1        # sequence number at check-in
        self.priority        = 0
        self.weight_q        = 0.0
        self.moisture        = 0.0
        self.amount          = 0.0
        self.resched_count   = 0
        self.parent_bid      = None
        self.history         = []        # [(status_str, context_str)]

    def __repr__(self):
        return f"[{self.token} | {self.status.value}]"


# ==============================================================
# CORE ENGINE
# ==============================================================

class Engine:

    def __init__(self):
        self.farmers: Dict[str, Farmer]  = {}
        self.mandis:  Dict[str, Mandi]   = {}
        self.bookings: Dict[str, Booking] = {}   # key = token
        self.daily:   Dict[Tuple[str,int], DailyStatus] = {}
        self.day       = 1
        self.sms_log: List[str] = []
        self._seq      = 0                       # global check-in sequence
        self._tok_seq: Dict[str, int] = defaultdict(int)

    # ── helpers ─────────────────────────────────────────────

    def _sms(self, fid, msg):
        f = self.farmers[fid]
        line = f"  📱 SMS → {f.name} ({f.phone}): {msg}"
        self.sms_log.append(line)
        print(line)

    def _log(self, msg):
        print(f"  ⚙️  {msg}")

    def _ds(self, mid, day) -> DailyStatus:
        """Get-or-create daily status for a mandi on a day."""
        k = (mid, day)
        if k not in self.daily:
            self.daily[k] = DailyStatus(mid, day, self.mandis[mid].capacity)
        return self.daily[k]

    def _token(self, mid, day) -> str:
        k = f"{mid}-{day}"
        self._tok_seq[k] += 1
        return f"{mid}-D{day}-{self._tok_seq[k]:03d}"

    def _move(self, bk: Booking, to: Status) -> bool:
        """Guarded state transition."""
        ok = TRANSITIONS.get(bk.status, [])
        if to not in ok:
            print(f"  ❌ ILLEGAL: {bk.status.value} → {to.value} "
                  f"(allowed: {[s.value for s in ok]})")
            return False
        old = bk.status
        bk.status = to
        bk.history.append((to.value, f"Day {self.day}"))
        self._log(f"{old.value} → {to.value}  [{bk.token}]")
        return True

    def _queue(self, mid) -> List[Booking]:
        """Sorted queue for a mandi today: highest priority first, then FIFO."""
        q = [b for b in self.bookings.values()
             if b.mid == mid and b.day == self.day
             and b.status == Status.IN_QUEUE]
        q.sort(key=lambda b: (-b.priority, b.checkin_seq))
        return q

    def _qpos(self, bk: Booking) -> int:
        for i, b in enumerate(self._queue(bk.mid)):
            if b.token == bk.token:
                return i + 1
        return -1

    def _find_slot(self, pref_mid, start_day):
        """Find earliest available slot, same mandi first, then others."""
        for d in range(start_day, start_day + 10):
            ds = self._ds(pref_mid, d)
            if not ds.paused and ds.bookable > 0:
                return d, pref_mid
        for mid in self.mandis:
            if mid == pref_mid:
                continue
            for d in range(start_day, start_day + 10):
                ds = self._ds(mid, d)
                if not ds.paused and ds.bookable > 0:
                    return d, mid
        return None, None

    def _active(self, fid) -> Optional[Booking]:
        """Return farmer's active booking, if any."""
        for b in self.bookings.values():
            if b.fid == fid and b.status not in TERMINAL_STATES:
                return b
        return None

    # ── public ops ──────────────────────────────────────────

    def add_farmer(self, fid, name, phone, village, district, acres):
        self.farmers[fid] = Farmer(fid, name, phone, village, district, acres)

    def add_mandi(self, mid, name, district, cap):
        self.mandis[mid] = Mandi(mid, name, district, cap)

    def book(self, fid, mid, day, crop) -> Optional[Booking]:
        """Attempt to book a slot.  Returns Booking or None."""
        if fid not in self.farmers:
            print(f"  ❌ Farmer {fid} not registered"); return None
        if mid not in self.mandis:
            print(f"  ❌ Mandi {mid} not found"); return None
        if day < self.day:
            print(f"  ❌ Can't book past day (today={self.day})"); return None

        act = self._active(fid)
        if act:
            print(f"  ❌ {self.farmers[fid].name} already has "
                  f"active booking {act.token} ({act.status.value})")
            return None

        ds = self._ds(mid, day)
        if ds.paused:
            print(f"  ❌ {self.mandis[mid].name} PAUSED Day {day}: "
                  f"{ds.pause_reason}"); return None
        if ds.bookable <= 0:
            print(f"  ❌ FULL — {self.mandis[mid].name} Day {day} "
                  f"({ds.booked}/{ds.cap_total - ds.cap_buffer})")
            return None

        token = self._token(mid, day)
        bk = Booking(fid, mid, day, crop, token)
        bk.history.append((Status.BOOKED.value, f"Day {self.day}"))
        self.bookings[token] = bk
        ds.booked += 1

        self._log(f"BOOKED: {self.farmers[fid].name} → "
                  f"{self.mandis[mid].name} Day {day}  [{token}]")
        self._sms(fid,
            f"✅ CONFIRMED | Token: {token} | "
            f"{self.mandis[mid].name}, Day {day} | "
            f"Crop: {crop.value}")
        return bk

    def checkin(self, token) -> bool:
        """Check in a farmer at the mandi gate."""
        if token not in self.bookings:
            print(f"  ❌ Token {token} not found"); return False
        bk = self.bookings[token]

        if bk.day != self.day:
            print(f"  ❌ Token is for Day {bk.day}, today is Day {self.day}")
            return False

        # RE_INSPECTION tokens skip CHECKED_IN, go straight to IN_QUEUE
        if bk.status == Status.RE_INSPECTION:
            if not self._move(bk, Status.IN_QUEUE):
                return False
            self._seq += 1
            bk.checkin_seq = self._seq
            bk.priority = 800
            self._ds(bk.mid, self.day).checked_in += 1
            self._ds(bk.mid, self.day).drying_count = max(
                0, self._ds(bk.mid, self.day).drying_count - 1)
            pos = self._qpos(bk)
            self._sms(bk.fid,
                f"🔄 Re-inspection check-in | {token} | Queue #{pos}")
            return True

        # Normal flow: BOOKED → CHECKED_IN → IN_QUEUE
        if not self._move(bk, Status.CHECKED_IN):
            return False
        if not self._move(bk, Status.IN_QUEUE):
            return False

        self._seq += 1
        bk.checkin_seq = self._seq
        bk.priority = (500 + bk.resched_count * 100) if bk.resched_count > 0 else 0

        self._ds(bk.mid, self.day).checked_in += 1
        pos = self._qpos(bk)
        self._sms(bk.fid,
            f"✅ Checked in | {token} | Queue #{pos} | "
            f"Est. wait: ~{pos * 20} min")
        return True

    def call_next(self, mid) -> Optional[Booking]:
        """Pull the highest-priority farmer from queue to weighing."""
        q = self._queue(mid)
        if not q:
            print(f"  ℹ️  Queue empty at {self.mandis[mid].name}")
            return None

        ds = self._ds(mid, self.day)
        if ds.bags < BAGS_PER_FARMER:
            print(f"  ❌ BARDANA EXHAUSTED at {self.mandis[mid].name} — "
                  f"{ds.bags} bags left (need {BAGS_PER_FARMER})")
            self._log("Recommend: pause mandi and reschedule.")
            return None

        nxt = q[0]
        if not self._move(nxt, Status.WEIGHING):
            return None

        self._sms(nxt.fid,
            f"🔔 YOUR TURN | Token {nxt.token} | Go to weighing bridge")

        # Notify next 2
        remaining = self._queue(mid)
        for i, b in enumerate(remaining[:2]):
            self._sms(b.fid,
                f"Queue update: #{i+1}, est. ~{(i+1)*20} min")
        return nxt

    def accept(self, token, weight_q) -> bool:
        """Accept crop after weighing — triggers payment."""
        if token not in self.bookings:
            print(f"  ❌ Token {token} not found"); return False
        bk = self.bookings[token]
        if bk.status != Status.WEIGHING:
            print(f"  ❌ {token} is {bk.status.value}, not WEIGHING")
            return False

        bk.weight_q = weight_q
        rate = MSP_RATE.get(bk.crop, 2000)
        bk.amount = weight_q * rate

        if not self._move(bk, Status.ACCEPTED):
            return False
        if not self._move(bk, Status.PAYMENT_INITIATED):
            return False

        ds = self._ds(bk.mid, self.day)
        ds.completed += 1
        ds.bags = max(0, ds.bags - int(weight_q * 2))
        ds.storage_pct = min(100, ds.storage_pct + int(weight_q * 0.5))

        self._sms(bk.fid,
            f"✅ ACCEPTED | {weight_q}q × ₹{rate} = "
            f"₹{bk.amount:,.0f} | Payment INITIATED")
        return True

    def reject_moisture(self, token, reading) -> Optional[str]:
        """Reject for moisture → create re-inspection token."""
        if token not in self.bookings:
            print(f"  ❌ Token {token} not found"); return None
        bk = self.bookings[token]
        if bk.status != Status.WEIGHING:
            print(f"  ❌ {token} is {bk.status.value}, not WEIGHING")
            return None

        limit = MOISTURE_LIMIT.get(bk.crop, 17.0)
        gap   = reading - limit
        dry_days = max(1, round(gap / 2.0))
        re_day   = self.day + dry_days

        bk.moisture = reading
        if not self._move(bk, Status.REJECTED_MOISTURE):
            return None
        if not self._move(bk, Status.DRYING):
            return None

        # Block yard space for drying days
        for d in range(self.day, re_day + 1):
            self._ds(bk.mid, d).drying_count += 1

        # Create re-inspection booking (from buffer, not bookable pool)
        re_tok = self._token(bk.mid, re_day)
        re_bk  = Booking(bk.fid, bk.mid, re_day, bk.crop, re_tok)
        re_bk.status     = Status.RE_INSPECTION
        re_bk.parent_bid = bk.bid
        re_bk.priority   = 800
        re_bk.history.append(("RE_INSPECTION", f"Day {self.day} (auto)"))
        self.bookings[re_tok] = re_bk

        self._sms(bk.fid,
            f"❌ MOISTURE {reading}% (limit {limit}%) | "
            f"Dry ~{dry_days} day(s) | "
            f"Re-inspect Day {re_day} | New token: {re_tok}")
        return re_tok

    def pause(self, mid, reason) -> int:
        """Pause mandi → reschedule all BOOKED farmers for today + tomorrow."""
        m  = self.mandis[mid]
        ds = self._ds(mid, self.day)
        ds.paused = True
        ds.pause_reason = reason

        # Also pause tomorrow
        ds2 = self._ds(mid, self.day + 1)
        ds2.paused = True
        ds2.pause_reason = reason

        self._log(f"🔴 PAUSED: {m.name} | {reason}")
        self._log("Farmers already IN_QUEUE / WEIGHING stay — "
                  "they are physically present.")

        to_resched = [
            b for b in self.bookings.values()
            if b.mid == mid
            and b.day in (self.day, self.day + 1)
            and b.status == Status.BOOKED
        ]

        count = 0
        for bk in to_resched:
            nd, nm = self._find_slot(mid, self.day + 2)
            if nd is None:
                self._sms(bk.fid,
                    f"⚠️ {m.name} PAUSED ({reason}). "
                    f"No slots nearby. We'll SMS when available. "
                    f"DO NOT travel.")
                continue

            # Mark old booking rescheduled
            bk.status = Status.RESCHEDULED
            bk.history.append(("RESCHEDULED", f"Day {self.day}"))

            # Create new booking
            new_tok = self._token(nm, nd)
            nb = Booking(bk.fid, nm, nd, bk.crop, new_tok)
            nb.resched_count = bk.resched_count + 1
            nb.parent_bid    = bk.bid
            nb.history.append(("BOOKED", f"Day {self.day} (rescheduled)"))
            self.bookings[new_tok] = nb
            self._ds(nm, nd).booked += 1

            mn = self.mandis[nm].name
            if nm == mid:
                self._sms(bk.fid,
                    f"⚠️ {m.name} PAUSED ({reason}). "
                    f"Rescheduled → Day {nd}, same mandi. "
                    f"New token: {new_tok}")
            else:
                self._sms(bk.fid,
                    f"⚠️ {m.name} PAUSED ({reason}). "
                    f"Moved → {mn} Day {nd}. "
                    f"New token: {new_tok}")
            count += 1

        self._log(f"Rescheduled {count} farmer(s)")
        return count

    def resume(self, mid):
        ds = self._ds(mid, self.day)
        ds.paused = False
        ds.pause_reason = ""
        self._log(f"🟢 RESUMED: {self.mandis[mid].name}")

    def no_shows(self, mid) -> int:
        """Mark all still-BOOKED farmers as NO_SHOW; release slots."""
        ns = [b for b in self.bookings.values()
              if b.mid == mid and b.day == self.day
              and b.status == Status.BOOKED]
        for bk in ns:
            bk.status = Status.NO_SHOW
            bk.history.append(("NO_SHOW", f"Day {self.day}"))
            self._sms(bk.fid,
                f"⏰ MISSED | Token {bk.token} expired. "
                f"Reply REBOOK for a new date.")
        if ns:
            ds = self._ds(mid, self.day)
            ds.cap_buffer += len(ns)
            self._log(f"{len(ns)} no-show(s) — "
                      f"slots released to buffer (now {ds.cap_buffer})")
        return len(ns)

    def set_bags(self, mid, day, amount):
        """Set bardana stock directly (for scenario testing)."""
        ds = self._ds(mid, day)
        ds.bags = amount
        self._log(f"Bardana at {self.mandis[mid].name} Day {day}: "
                  f"{ds.bags} bags")

    def mark_paid(self, token):
        if token not in self.bookings:
            print(f"  ❌ Token {token} not found"); return
        bk = self.bookings[token]
        if bk.status != Status.PAYMENT_INITIATED:
            print(f"  ❌ {token} is {bk.status.value}"); return
        bk.status = Status.PAID
        bk.history.append(("PAID", f"Day {self.day}"))
        self._sms(bk.fid,
            f"💰 ₹{bk.amount:,.0f} credited to your bank account!")

    def next_day(self):
        self.day += 1
        self._log(f"{'═'*20} DAY {self.day} {'═'*20}")
        # Announce re-inspections due today
        for b in self.bookings.values():
            if b.status == Status.RE_INSPECTION and b.day == self.day:
                self._log(f"Re-inspection due: {b.token} "
                          f"({self.farmers[b.fid].name})")

    # ── views ───────────────────────────────────────────────

    def show_mandi(self, mid):
        m  = self.mandis[mid]
        ds = self._ds(mid, self.day)
        q  = self._queue(mid)
        ic = {True: "🔴", False: "🟢"}

        print(f"\n{'━'*55}")
        print(f"  📍 {m.name} | DAY {self.day}")
        print(f"{'━'*55}")
        print(f"  Status:    {ic[ds.paused]} "
              f"{'PAUSED (' + ds.pause_reason + ')' if ds.paused else 'ACTIVE'}")
        print(f"  Capacity:  {ds.cap_total}/day  "
              f"(buffer {ds.cap_buffer}, drying {ds.drying_count})")
        print(f"  Booked:    {ds.booked}  |  "
              f"Checked-in: {ds.checked_in}  |  "
              f"Done: {ds.completed}")
        print(f"  Bookable:  {ds.bookable} slot(s) remaining")
        print(f"  Bardana:   {ds.bags} bags")
        print(f"  Storage:   {ds.storage_pct}%")

        if q:
            print(f"\n  📋 QUEUE ({len(q)} waiting):")
            for i, b in enumerate(q):
                fn = self.farmers[b.fid].name
                p  = f" [pri:{b.priority}]" if b.priority else ""
                r  = f" (resched ×{b.resched_count})" if b.resched_count else ""
                print(f"    #{i+1}  {fn:<18} {b.token}{p}{r}")

        w = [b for b in self.bookings.values()
             if b.mid == mid and b.day == self.day
             and b.status == Status.WEIGHING]
        if w:
            print(f"\n  ⚖️  AT WEIGHING:")
            for b in w:
                print(f"    {self.farmers[b.fid].name:<18} {b.token}")

        dr = [b for b in self.bookings.values()
              if b.mid == mid and b.status == Status.DRYING]
        if dr:
            print(f"\n  ☀️  DRYING IN YARD:")
            for b in dr:
                ri = [x for x in self.bookings.values()
                      if x.parent_bid == b.bid
                      and x.status == Status.RE_INSPECTION]
                rd = ri[0].day if ri else "?"
                print(f"    {self.farmers[b.fid].name:<18} "
                      f"Moisture {b.moisture}% → re-inspect Day {rd}")
        print(f"{'━'*55}\n")

    def show_farmer(self, fid):
        if fid not in self.farmers:
            print(f"  ❌ Farmer {fid} not found"); return
        f = self.farmers[fid]
        print(f"\n{'─'*50}")
        print(f"  👨‍🌾 {f.name} | {f.village}, {f.district} | "
              f"{f.acres} acres")
        print(f"  📞 {f.phone}")
        bks = [b for b in self.bookings.values() if b.fid == fid]
        if bks:
            print(f"  📜 BOOKINGS:")
            icons = {"BOOKED":"📅","IN_QUEUE":"⏳","WEIGHING":"⚖️",
                     "ACCEPTED":"✅","PAID":"💰","CANCELLED":"❌",
                     "NO_SHOW":"⏰","RESCHEDULED":"🔄","DRYING":"☀️",
                     "RE_INSPECTION":"🔄","REJECTED_MOISTURE":"💧",
                     "PAYMENT_INITIATED":"💳","CHECKED_IN":"📋"}
            for b in bks:
                ic = icons.get(b.status.value, "•")
                mn = self.mandis[b.mid].name
                ex = ""
                if b.weight_q:  ex += f" | {b.weight_q}q=₹{b.amount:,.0f}"
                if b.moisture:  ex += f" | moist:{b.moisture}%"
                if b.resched_count: ex += f" | resched×{b.resched_count}"
                print(f"    {ic} {b.token} | {mn} D{b.day} | "
                      f"{b.status.value}{ex}")
                for st, ctx in b.history:
                    print(f"       └─ {st} ({ctx})")
        else:
            print("  No bookings.")
        print(f"{'─'*50}\n")

    def show_all(self):
        print(f"\n{'═'*55}")
        print(f"  SYSTEM OVERVIEW | DAY {self.day}")
        print(f"{'═'*55}")
        for mid, m in self.mandis.items():
            ds = self._ds(mid, self.day)
            ic = "🔴" if ds.paused else "🟢"
            ql = len(self._queue(mid))
            print(f"  {ic} {m.name:<14} | "
                  f"Bkd:{ds.booked}/{ds.cap_total} | "
                  f"Q:{ql} | Done:{ds.completed} | "
                  f"Bags:{ds.bags}")
        print(f"{'═'*55}\n")


# ==============================================================
# SEED DATA
# ==============================================================

def seed() -> Engine:
    e = Engine()
    e.add_mandi("KNL", "Karnal",    "Karnal", 8)
    e.add_mandi("NLK", "Nilokheri", "Karnal", 6)
    e.add_mandi("GHR", "Gharaunda", "Karnal", 5)

    data = [
        ("F01","Ramesh Singh",   "9876500001","Dhanauri",  "Karnal",5.0),
        ("F02","Sukhdev Pal",    "9876500002","Dhanauri",  "Karnal",3.0),
        ("F03","Manjeet Kaur",   "9876500003","Bastli",    "Karnal",8.0),
        ("F04","Harpal Kumar",   "9876500004","Bastli",    "Karnal",2.5),
        ("F05","Balwinder Singh","9876500005","Gharaunda", "Karnal",6.0),
        ("F06","Gurpreet Kaur",  "9876500006","Gharaunda", "Karnal",4.0),
        ("F07","Jaswant Rao",    "9876500007","Nilokheri", "Karnal",7.0),
        ("F08","Mohinder Pal",   "9876500008","Nilokheri", "Karnal",3.5),
        ("F09","Darshan Singh",  "9876500009","Kunjpura",  "Karnal",10.),
        ("F10","Prakash Chand",  "9876500010","Kunjpura",  "Karnal",2.0),
        ("F11","Satish Kumar",   "9876500011","Indri",     "Karnal",4.5),
        ("F12","Rani Devi",      "9876500012","Indri",     "Karnal",3.0),
        ("F13","Vikram Jat",     "9876500013","Assandh",   "Karnal",6.5),
        ("F14","Sunita Rani",    "9876500014","Assandh",   "Karnal",2.0),
        ("F15","Bhagwan Das",    "9876500015","Taraori",   "Karnal",5.5),
    ]
    for fid, nm, ph, vil, dist, ac in data:
        e.add_farmer(fid, nm, ph, vil, dist, ac)
    return e


# ==============================================================
# TEST SCENARIOS
# ==============================================================

def pause_prompt():
    try:
        input("\n  [Enter to continue...] ")
    except EOFError:
        pass

def sc_happy(e: Engine):
    print("\n" + "="*60)
    print("  SCENARIO: HAPPY PATH — Normal procurement flow")
    print("  Book → Check-in → Weigh → Accept → Pay")
    print("="*60)

    print("\n── 1. Book 3 farmers at Karnal, Day 1 ──")
    b1 = e.book("F01", "KNL", 1, Crop.PADDY)
    b2 = e.book("F02", "KNL", 1, Crop.PADDY)
    b3 = e.book("F03", "KNL", 1, Crop.WHEAT)

    print("\n── 2. All 3 check in ──")
    e.checkin(b1.token)
    e.checkin(b2.token)
    e.checkin(b3.token)
    e.show_mandi("KNL")

    print("── 3. Call next → Ramesh to weighing ──")
    e.call_next("KNL")

    print("\n── 4. Accept Ramesh (42 quintals paddy) ──")
    e.accept(b1.token, 42.0)

    print("\n── 5. Call + accept Sukhdev (28q) ──")
    e.call_next("KNL")
    e.accept(b2.token, 28.0)

    print("\n── 6. Call + accept Manjeet (65q wheat) ──")
    e.call_next("KNL")
    e.accept(b3.token, 65.0)

    e.show_mandi("KNL")

    print("── 7. DBT credited (simulate) ──")
    e.mark_paid(b1.token)
    e.show_farmer("F01")

    print("✅ HAPPY PATH COMPLETE\n")


def sc_moisture(e: Engine):
    print("\n" + "="*60)
    print("  SCENARIO: MOISTURE REJECTION → DRYING → RE-INSPECTION")
    print("  Farmer's paddy has 19.5% moisture (limit 17%)")
    print("="*60)

    print("\n── 1. Book Harpal at Karnal, Day 1 ──")
    b = e.book("F04", "KNL", 1, Crop.PADDY)

    print("\n── 2. Check in ──")
    e.checkin(b.token)

    print("\n── 3. Call to weighing ──")
    e.call_next("KNL")

    print("\n── 4. REJECT — moisture 19.5% (limit 17%) ──")
    re_tok = e.reject_moisture(b.token, 19.5)
    e.show_mandi("KNL")

    print("── 5. Advance to Day 2 (crop still drying in yard) ──")
    e.next_day()

    print("\n── 6. Advance to Day 2 → Day 3 (re-inspection day) ──")
    e.next_day()

    if re_tok:
        print(f"\n── 7. Check in for re-inspection ({re_tok}) ──")
        e.checkin(re_tok)

        print("\n── 8. Call next (priority queue — re-inspection first) ──")
        e.call_next("KNL")

        print("\n── 9. Accept (moisture OK after drying) ──")
        e.accept(re_tok, 18.0)

    e.show_farmer("F04")
    print("✅ MOISTURE SCENARIO COMPLETE\n")


def sc_rain(e: Engine):
    print("\n" + "="*60)
    print("  SCENARIO: RAIN CASCADE")
    print("  Rain halts mandi mid-day. Cascading reschedule.")
    print("="*60)

    print("\n── 1. Book 6 farmers at Karnal Day 1 ──")
    b5 = e.book("F05", "KNL", 1, Crop.WHEAT)
    b6 = e.book("F06", "KNL", 1, Crop.WHEAT)
    b7 = e.book("F07", "KNL", 1, Crop.WHEAT)
    b8 = e.book("F08", "KNL", 1, Crop.WHEAT)
    b9 = e.book("F09", "KNL", 1, Crop.WHEAT)
    b10= e.book("F10", "KNL", 1, Crop.WHEAT)

    print("\n── 2. Book 4 farmers at Karnal Day 2 ──")
    b11= e.book("F11", "KNL", 2, Crop.WHEAT)
    b12= e.book("F12", "KNL", 2, Crop.WHEAT)
    b13= e.book("F13", "KNL", 2, Crop.WHEAT)
    b14= e.book("F14", "KNL", 2, Crop.WHEAT)

    print("\n── 3. First 3 check in (F05-F07 physically at mandi) ──")
    e.checkin(b5.token)
    e.checkin(b6.token)
    e.checkin(b7.token)

    print("\n── 4. Process 2 (Balwinder + Gurpreet accepted) ──")
    e.call_next("KNL")
    e.accept(b5.token, 50.0)
    e.call_next("KNL")
    e.accept(b6.token, 35.0)
    e.show_mandi("KNL")

    print("── 5. ⛈️  RAIN STARTS — operator pauses mandi ──")
    print("       Jaswant still in queue. F08-F10 haven't arrived.")
    print("       F11-F14 booked for tomorrow.")
    e.pause("KNL", "HEAVY RAIN")
    e.show_mandi("KNL")
    e.show_all()

    print("── 6. Advance to Day 2 (rain continues) ──")
    e.next_day()
    e.show_all()

    print("── 7. Advance to Day 3 (rain stops, resume) ──")
    e.next_day()
    e.resume("KNL")
    e.show_all()

    print("── Where did everyone end up? ──")
    for fid in ["F05","F06","F07","F08","F09","F10",
                "F11","F12","F13","F14"]:
        e.show_farmer(fid)

    print("✅ RAIN CASCADE COMPLETE\n")


def sc_noshow(e: Engine):
    print("\n" + "="*60)
    print("  SCENARIO: NO-SHOW RECOVERY")
    print("  2 of 5 farmers don't show up. Slots reclaimed.")
    print("="*60)

    print("\n── 1. Book 5 farmers at Nilokheri Day 1 ──")
    b1 = e.book("F01", "NLK", 1, Crop.PADDY)
    b2 = e.book("F02", "NLK", 1, Crop.PADDY)
    b3 = e.book("F03", "NLK", 1, Crop.PADDY)
    b4 = e.book("F04", "NLK", 1, Crop.PADDY)
    b5 = e.book("F05", "NLK", 1, Crop.PADDY)

    print("\n── 2. Only F01, F02, F03 check in (F04, F05 absent) ──")
    e.checkin(b1.token)
    e.checkin(b2.token)
    e.checkin(b3.token)
    e.show_mandi("NLK")

    print("── 3. Midday — trigger no-show processing ──")
    e.no_shows("NLK")
    e.show_mandi("NLK")

    print("── F04 and F05 status ──")
    e.show_farmer("F04")
    e.show_farmer("F05")
    print("✅ NO-SHOW SCENARIO COMPLETE\n")


def sc_bardana(e: Engine):
    print("\n" + "="*60)
    print("  SCENARIO: BARDANA CLIFF")
    print("  Bags run out after 1 farmer. Queue stalls.")
    print("="*60)

    print("\n── 1. Book 4 farmers at Gharaunda Day 1 ──")
    b1 = e.book("F01", "GHR", 1, Crop.WHEAT)
    b2 = e.book("F02", "GHR", 1, Crop.WHEAT)
    b3 = e.book("F03", "GHR", 1, Crop.WHEAT)
    b4 = e.book("F04", "GHR", 1, Crop.WHEAT)

    print("\n── 2. Simulate bardana shortage (set to 25 bags) ──")
    e.set_bags("GHR", 1, 25)

    print("\n── 3. All 4 check in ──")
    e.checkin(b1.token)
    e.checkin(b2.token)
    e.checkin(b3.token)
    e.checkin(b4.token)

    print("\n── 4. Process farmer 1 (uses ~20 bags → 5 left) ──")
    e.call_next("GHR")
    e.accept(b1.token, 42.0)
    e.show_mandi("GHR")

    print("── 5. Try to call next — BARDANA EXHAUSTED ──")
    result = e.call_next("GHR")

    if result is None:
        print("\n── 6. Operator must pause mandi ──")
        e.pause("GHR", "NO BARDANA")
        e.show_mandi("GHR")
        e.show_all()

    print("── Where did remaining farmers get rescheduled? ──")
    e.show_farmer("F02")
    e.show_farmer("F03")
    e.show_farmer("F04")
    print("✅ BARDANA CLIFF COMPLETE\n")


# ==============================================================
# INTERACTIVE CLI
# ==============================================================

def cli(e: Engine):
    while True:
        print(f"\n{'─'*50}")
        print(f"  📅 DAY {e.day}")
        print(f"{'─'*50}")
        print("  1.  Book Slot           9.  Set Bardana Stock")
        print("  2.  Check In           10.  Advance Day")
        print("  3.  Call Next          11.  Mark Paid")
        print("  4.  Accept Crop        ─── VIEWS ───")
        print("  5.  Reject Moisture    12.  View Mandi")
        print("  6.  Pause Mandi        13.  View All Mandis")
        print("  7.  Resume Mandi       14.  View Farmer")
        print("  8.  Process No-Shows   15.  SMS Log (last 15)")
        print("  0.  Exit")
        print(f"{'─'*50}")

        try:
            c = input("  > ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if c == "0":
            break
        elif c == "1":
            print("  Farmers:", ", ".join(
                f"{fid}({f.name})" for fid, f in e.farmers.items()
                if not e._active(fid)))
            fid = input("  Farmer ID: ").strip()
            print("  Mandis:", ", ".join(
                f"{mid}({m.name}, avail={e._ds(mid, e.day).bookable})"
                for mid, m in e.mandis.items()))
            mid = input("  Mandi ID: ").strip()
            day = input(f"  Day [{e.day}]: ").strip()
            day = int(day) if day else e.day
            print("  Crops: WHEAT, PADDY, MUSTARD")
            cr = input("  Crop: ").strip().upper()
            crop = Crop[cr] if cr in Crop.__members__ else Crop.WHEAT
            e.book(fid, mid, day, crop)
        elif c == "2":
            e.checkin(input("  Token: ").strip())
        elif c == "3":
            e.call_next(input("  Mandi ID: ").strip())
        elif c == "4":
            tok = input("  Token: ").strip()
            wt  = float(input("  Weight (quintals): ").strip())
            e.accept(tok, wt)
        elif c == "5":
            tok = input("  Token: ").strip()
            m   = float(input("  Moisture %: ").strip())
            e.reject_moisture(tok, m)
        elif c == "6":
            mid = input("  Mandi ID: ").strip()
            r   = input("  Reason (RAIN/NO_BAGS/STORAGE_FULL): ").strip()
            e.pause(mid, r)
        elif c == "7":
            e.resume(input("  Mandi ID: ").strip())
        elif c == "8":
            e.no_shows(input("  Mandi ID: ").strip())
        elif c == "9":
            mid = input("  Mandi ID: ").strip()
            amt = int(input("  Set bags to: ").strip())
            e.set_bags(mid, e.day, amt)
        elif c == "10":
            e.next_day()
        elif c == "11":
            e.mark_paid(input("  Token: ").strip())
        elif c == "12":
            e.show_mandi(input("  Mandi ID: ").strip())
        elif c == "13":
            e.show_all()
        elif c == "14":
            e.show_farmer(input("  Farmer ID: ").strip())
        elif c == "15":
            print(f"\n  📱 SMS LOG (last 15):")
            for s in e.sms_log[-15:]:
                print(f"  {s}")


# ==============================================================
# MAIN
# ==============================================================

def main():
    print("""
╔════════════════════════════════════════════════════════════╗
║  MANDI QUEUE MANAGEMENT ENGINE — Terminal Prototype       ║
║  SIH 2026 | PS 26032 | DoCA                              ║
║                                                           ║
║  3 Mandis: KNL (cap 8), NLK (cap 6), GHR (cap 5)        ║
║  15 Farmers: F01–F15                                      ║
╚════════════════════════════════════════════════════════════╝

  1. Run ALL Scenarios (automated demo, no input needed)
  2. Run Specific Scenario → then interactive
  3. Interactive Sandbox (pre-loaded data)
  4. Empty Interactive (build from scratch)
""")
    try:
        mode = input("  Mode [1]: ").strip() or "1"
    except (EOFError, KeyboardInterrupt):
        mode = "1"

    if mode == "1":
        for name, fn in [("HAPPY PATH",    sc_happy),
                         ("MOISTURE",      sc_moisture),
                         ("RAIN CASCADE",  sc_rain),
                         ("NO-SHOW",       sc_noshow),
                         ("BARDANA CLIFF", sc_bardana)]:
            e = seed()
            fn(e)
            pause_prompt()
        print("\n  ALL SCENARIOS DONE.\n")

    elif mode == "2":
        print("  a) Happy Path  b) Moisture  c) Rain  d) No-Show  e) Bardana")
        ch = input("  > ").strip().lower()
        fns = {"a": sc_happy, "b": sc_moisture, "c": sc_rain,
               "d": sc_noshow, "e": sc_bardana}
        if ch in fns:
            e = seed(); fns[ch](e)
            print("\n  Dropping into interactive mode...\n")
            cli(e)

    elif mode == "3":
        e = seed()
        print("  Loaded: 3 mandis, 15 farmers.\n")
        e.show_all()
        cli(e)

    elif mode == "4":
        e = Engine()
        print("  Empty system. Add mandis and farmers first.\n")
        cli(e)

    else:
        e = seed(); sc_happy(e)

if __name__ == "__main__":
    main()
