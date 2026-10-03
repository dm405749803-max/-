const assert=require('node:assert/strict');
const {createPlanHarness}=require('./harness.cjs');
const {evaluate}=createPlanHarness();

// D03: unknown is not zero; explicit zero remains zero; malformed values are rejected.
assert.equal(evaluate("nullableNumber('')"),null);
assert.equal(evaluate("nullableNumber('0')"),0);
assert.equal(evaluate("normalizePlanRows([{year:1,premium:'',benefit:0,cashValue:90,deathBenefit:100}])[0].premium"),null);
assert.throws(()=>evaluate("parsePlanText('保单年度,当年保费,当年领取,年末现金价值,身故保险金\\n1,,0,90,100')"),/保费未知，不能按 0/);
assert.throws(()=>evaluate("normalizePlanRows([{year:1,premium:'abc',benefit:0,cashValue:90,deathBenefit:100}])"),/有限数值/);

// D04: policy years are actual yearly time points and may not be compressed.
assert.throws(()=>evaluate("parsePlanText('保单年度,当年保费,当年领取,年末现金价值,身故保险金\\n1,100,0,90,100\\n10,0,0,150,150')"),/缺少第 2 年/);
assert.throws(()=>evaluate("parsePlanText('保单年度,当年保费,当年领取,年末现金价值,身故保险金\\n1,100,0,90,100\\n1,0,0,100,100')"),/年度 1 重复/);

// Independent known cashflow: -100 at t0 and 121 at t2 is exactly 10% annual IRR.
const known=evaluate("calculatePlan(parsePlanText('保单年度,当年保费,当年领取,年末现金价值,身故保险金\\n1,100,0,110,110\\n2,0,0,121,121'))");
assert.ok(Math.abs(known.summary.lastSurrenderIrr-0.1)<1e-10);
assert.ok(Math.abs(known.summary.lastDeathIrr-0.1)<1e-10);
assert.equal(known.currency,'CNY');
assert.match(known.timingBasis,/保费.*期初.*现金价值.*期末/);

// D05: a confirmed plan is tied to the exact customer/opportunity conditions.
evaluate("state.planBooks.c1={...calculatePlan(parsePlanText('保单年度,当年保费,当年领取,年末现金价值,身故保险金\\n1,100,0,110,110')),confirmed:true,confirmedAt:'2026-09-23',productVersion:state.product.version}");
assert.equal(evaluate('planIsCurrent(state.planBooks.c1,state.customers[0])'),true);
evaluate("state.customers[0].premium='50000'");
assert.equal(evaluate('planIsCurrent(state.planBooks.c1,state.customers[0])'),false);

console.log('PASS — D03 unknown amounts, D04 actual annual timing, D05 condition-bound plans, and exact IRR fixture.');
