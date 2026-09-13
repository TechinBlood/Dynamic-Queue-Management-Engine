/**
 * TEST: Mandi Rerouting
 * 
 * Scenario: Karnal is FULL for the next 5 days.
 * Rain hits → system can't reschedule at Karnal → reroutes to Nilokheri/Gharaunda.
 * 
 * RUN: node test_rerouting.js
 */

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/mandi_sandbox.js', 'utf8');
const coreEnd = src.indexOf('// ─── INTERACTIVE MENU');
eval(src.substring(0, coreEnd));

const e = seed();

function step(n, desc) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  STEP ${n}: ${desc}`);
  console.log(`${'─'.repeat(60)}\n`);
}

// ═══════════════════════════════════════════════════════════
step(1, 'Fill Karnal completely for Day 1 to Day 5');
// ═══════════════════════════════════════════════════════════

// We only have 15 farmers, so we'll use a trick:
// Register extra dummy farmers to fill multiple days
const extras = [
  ['X01','Ajay Sharma','9999900001','Panipat','Karnal',4],
  ['X02','Vijay Nagar','9999900002','Panipat','Karnal',3],
  ['X03','Raju Yadav','9999900003','Panipat','Karnal',5],
  ['X04','Sita Devi','9999900004','Panipat','Karnal',2],
  ['X05','Gopal Das','9999900005','Panipat','Karnal',6],
  ['X06','Meena Kumari','9999900006','Panipat','Karnal',3],
  ['X07','Bhola Nath','9999900007','Panipat','Karnal',4],
  ['X08','Kamla Rani','9999900008','Panipat','Karnal',5],
  ['X09','Tek Chand','9999900009','Panipat','Karnal',3],
  ['X10','Parveen Kumar','9999900010','Panipat','Karnal',4],
  ['X11','Deepak Raj','9999900011','Panipat','Karnal',6],
  ['X12','Anita Devi','9999900012','Panipat','Karnal',2],
  ['X13','Mahesh Pal','9999900013','Panipat','Karnal',5],
  ['X14','Kiran Bala','9999900014','Panipat','Karnal',3],
  ['X15','Roshan Lal','9999900015','Panipat','Karnal',4],
  ['X16','Babita Rani','9999900016','Panipat','Karnal',5],
  ['X17','Naresh Kumar','9999900017','Panipat','Karnal',3],
  ['X18','Pooja Devi','9999900018','Panipat','Karnal',4],
  ['X19','Suresh Pal','9999900019','Panipat','Karnal',6],
  ['X20','Geeta Rani','9999900020','Panipat','Karnal',2],
  ['X21','Mohan Lal','9999900021','Panipat','Karnal',5],
];
extras.forEach(([fid,name,phone,village,district,acres]) =>
  e.F.set(fid,{fid,name,phone,village,district,acres}));

// Karnal cap = 8, buffer = 1, so 7 bookable per day
// Fill Day 1
console.log('  Booking 7 farmers at Karnal Day 1...');
['F01','F02','F03','F04','F05','F06','F07'].forEach(f => e.book(f,'KNL',1,'PADDY'));

// Fill Day 2
console.log('\n  Booking 7 farmers at Karnal Day 2...');
['F08','F09','F10','F11','F12','F13','F14'].forEach(f => e.book(f,'KNL',2,'PADDY'));

// Fill Day 3
console.log('\n  Booking 7 farmers at Karnal Day 3...');
['F15','X01','X02','X03','X04','X05','X06'].forEach(f => e.book(f,'KNL',3,'PADDY'));

// Fill Day 4
console.log('\n  Booking 7 farmers at Karnal Day 4...');
['X07','X08','X09','X10','X11','X12','X13'].forEach(f => e.book(f,'KNL',4,'PADDY'));

// Fill Day 5
console.log('\n  Booking 7 farmers at Karnal Day 5...');
['X14','X15','X16','X17','X18','X19','X20'].forEach(f => e.book(f,'KNL',5,'PADDY'));

// Fill Day 6-11 too (so findSlot can't find anything at Karnal within 10-day window)
const moreExtras = [];
for(let i=22; i<=70; i++) {
  const id = `X${i}`;
  moreExtras.push([id,`Farmer${i}`,`99999${String(i).padStart(5,'0')}`,`Village${i}`,'Karnal',3]);
}
moreExtras.forEach(([fid,name,phone,village,district,acres]) =>
  e.F.set(fid,{fid,name,phone,village,district,acres}));

let extraIdx = 22;
for(let day=6; day<=12; day++) {
  console.log(`\n  Booking 7 farmers at Karnal Day ${day}...`);
  for(let j=0; j<7; j++) {
    e.book(`X${extraIdx}`,'KNL',day,'PADDY');
    extraIdx++;
  }
}

// ═══════════════════════════════════════════════════════════
step(2, 'Check — Karnal should be FULL Day 1 to Day 5');
// ═══════════════════════════════════════════════════════════
e.showSlots('KNL');

// ═══════════════════════════════════════════════════════════
step(3, '☔ RAIN HITS — Pause Karnal');
// ═══════════════════════════════════════════════════════════
console.log('  Operator pauses Karnal due to heavy rain...');
console.log('  Pause blocks Day 1 + Day 2.');
console.log('  Day 3, 4, 5 are already FULL at Karnal.');
console.log('  System has NO CHOICE but to reroute to Nilokheri/Gharaunda.\n');

e.pause('KNL', 'RAIN');

// ═══════════════════════════════════════════════════════════
step(4, 'Where did everyone land?');
// ═══════════════════════════════════════════════════════════
e.showAll();
e.showSlots('KNL');
e.showSlots('NLK');
e.showSlots('GHR');

// ═══════════════════════════════════════════════════════════
step(5, 'Check individual farmer trails — REROUTED farmers');
// ═══════════════════════════════════════════════════════════
console.log('  Checking Day 1 farmers (originally at Karnal):\n');
['F01','F02','F03'].forEach(f => e.showFarmer(f));

// ═══════════════════════════════════════════════════════════
step(6, 'SMS Log — see the rerouting messages');
// ═══════════════════════════════════════════════════════════
console.log('  Filtering only rerouting SMS:\n');
e.sms.filter(s => s.msg.includes('Rerouted')).forEach(s =>
  console.log(`  📱 [Day ${s.day}] → ${s.to}: ${s.msg}`)
);

const rescheduled = e.sms.filter(s => s.msg.includes('Rescheduled'));
const rerouted = e.sms.filter(s => s.msg.includes('Rerouted'));

console.log(`\n  ────────────────────────────────`);
console.log(`  📊 SUMMARY:`);
console.log(`     Rescheduled (same mandi, later day): ${rescheduled.length} farmers`);
console.log(`     Rerouted (different mandi):          ${rerouted.length} farmers`);
console.log(`  ────────────────────────────────\n`);

console.log('  ✅ TEST COMPLETE\n');
