/**
 * FULL TEST RUN — Just watch the output
 * Runs a realistic multi-day scenario automatically.
 * 
 * RUN: node test_run.js
 */

// ─── Pull in the Engine classes (copy the core, skip the menu) ───
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/mandi_sandbox.js', 'utf8');

// Extract everything before the INTERACTIVE MENU section
const coreEnd = src.indexOf('// ─── INTERACTIVE MENU');
const coreCode = src.substring(0, coreEnd);

// Evaluate the core engine code
eval(coreCode);

// ─── HELPERS ──────────────────────────────────────────────────
const e = seed();

function hr(label) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🧪 ${label}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ════════════════════════════════════════════════════════════════
//  SCENARIO: Full realistic multi-day Kharif procurement
// ════════════════════════════════════════════════════════════════

hr('DAY 1 — Booking Phase');
console.log('  6 farmers book at Karnal, 3 at Nilokheri\n');

e.book('F01','KNL',1,'PADDY');
e.book('F02','KNL',1,'PADDY');
e.book('F03','KNL',1,'PADDY');
e.book('F04','KNL',1,'PADDY');
e.book('F05','KNL',1,'PADDY');
e.book('F06','KNL',1,'PADDY');
e.book('F07','NLK',1,'PADDY');
e.book('F08','NLK',1,'PADDY');
e.book('F09','NLK',1,'PADDY');

// Also book 2 farmers for Day 2 (advance booking)
e.book('F10','KNL',2,'PADDY');
e.book('F11','KNL',2,'PADDY');

e.showAll();

hr('DAY 1 — Gate Check-In (5 of 6 arrive at Karnal, F04 no-show)');

e.checkin('KNL-D1-001'); // F01
e.checkin('KNL-D1-002'); // F02
e.checkin('KNL-D1-003'); // F03
// F04 doesn't show up!
e.checkin('KNL-D1-005'); // F05
e.checkin('KNL-D1-006'); // F06

e.showMandi('KNL');

hr('DAY 1 — Processing Queue at Karnal');

// Farmer 1: Accepted
console.log('\n  --- Farmer #1 ---');
e.callNext('KNL');
e.accept('KNL-D1-001', 42);

// Farmer 2: REJECTED — moisture too high!
console.log('\n  --- Farmer #2 (MOISTURE FAIL) ---');
e.callNext('KNL');
e.reject('KNL-D1-002', 21); // paddy limit is 17%

// Farmer 3: Accepted
console.log('\n  --- Farmer #3 ---');
e.callNext('KNL');
e.accept('KNL-D1-003', 38);

// Farmer 5: Accepted
console.log('\n  --- Farmer #5 ---');
e.callNext('KNL');
e.accept('KNL-D1-005', 55);

// Farmer 6: Accepted
console.log('\n  --- Farmer #6 ---');
e.callNext('KNL');
e.accept('KNL-D1-006', 28);

// Queue should be empty now
e.callNext('KNL');

hr('DAY 1 — End of Day: Process No-Shows');
e.noShows('KNL');

e.showMandi('KNL');

// Check Farmer 2's status (moisture rejected)
e.showFarmer('F02');

hr('DAY 1 — Payments');
e.paid('KNL-D1-001');
e.paid('KNL-D1-003');
e.paid('KNL-D1-005');
e.paid('KNL-D1-006');

hr('DAY 2 — New Day Begins');
e.nextDay();

// F10 and F11 had advance bookings for today
console.log('  F10, F11 booked in advance. Checking in...\n');
e.checkin('KNL-D2-001'); // F10
e.checkin('KNL-D2-002'); // F11

// Process them
e.callNext('KNL');
e.accept('KNL-D2-001', 30);
e.callNext('KNL');
e.accept('KNL-D2-002', 45);

e.showAll();

hr('DAY 2 — RAIN HITS! Pause Karnal');
e.book('F12','KNL',2,'PADDY');
e.book('F13','KNL',2,'PADDY');
e.book('F14','KNL',2,'PADDY');

console.log('\n  ☔ Heavy rain starts. Operator pauses Karnal...\n');
e.pause('KNL','RAIN');

e.showAll();

hr('DAY 2 — Check where rescheduled farmers landed');
e.showFarmer('F12');
e.showFarmer('F13');
e.showFarmer('F14');

hr('DAY 3 — F02 Re-inspection Day (was drying since Day 1)');
e.nextDay();

// F02's re-inspection token should be due today
console.log('  Looking for re-inspection tokens...\n');
const reinspect = Array.from(e.B.values()).filter(
  b => b.st === 'RE_INSPECTION' && b.day === e.day
);
reinspect.forEach(b => {
  console.log(`  🔔 ${e.F.get(b.fid).name}: Token ${b.tok} due for re-inspection\n`);
  e.checkin(b.tok);
});

if(reinspect.length) {
  e.showMandi('KNL');
  
  // Process re-inspection — this time moisture is fine
  const b = reinspect[0];
  e.callNext('KNL');
  console.log(`\n  Moisture OK this time. Accepting...\n`);
  e.accept(b.tok, 36);
  e.paid(b.tok);
}

hr('DAY 3 — Resume Karnal after rain');
e.resume('KNL');
e.showAll();

hr('DAY 3 — Bardana Shortage Test');
console.log('  Setting bags at Nilokheri to only 10 (need 20 per farmer)...\n');
e.setBags('NLK', 3, 10);

e.book('F04','NLK',3,'PADDY'); // F04 was a no-show earlier, can rebook now
e.checkin('NLK-D3-001');
e.callNext('NLK'); // Should FAIL — not enough bags!

hr('FINAL STATUS');
e.showAll();

hr('SMS LOG (all notifications sent)');
e.showSMS(50);

console.log('\n  ✅ ALL TESTS COMPLETE\n');
