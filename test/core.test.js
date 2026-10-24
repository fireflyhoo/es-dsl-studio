/* 核心逻辑冒烟测试：构建树 -> 生成 DSL -> 导入 -> 再生成，比对一致性 */
const Q = require('../web/js/queries.js');

let failed = 0;
// 键序无关的规范化比较
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
function eq(name, a, b) {
  const sa = JSON.stringify(canon(a)), sb = JSON.stringify(canon(b));
  if (sa === sb) console.log('PASS  ' + name);
  else { failed++; console.log('FAIL  ' + name + '\n  A=' + sa + '\n  B=' + sb); }
}
function ok(name, cond, extra) {
  if (cond) console.log('PASS  ' + name);
  else { failed++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

// ---- 1. 手工构建一棵 bool 树 ----
const bool = Q.mkNode('bool');
bool.params.minimum_should_match = '1';
const m = Q.mkNode('match');
m.params.field = 'title'; m.params.query = '智能手机'; m.params.operator = 'AND'; m.params.boost = '2';
const r = Q.mkNode('range');
r.params.field = 'price'; r.params.gte = '1000'; r.params.lte = '5000';
const t = Q.mkNode('term');
t.params.field = 'status'; t.params.value = '1';
const mp = Q.mkNode('match_phrase');
mp.params.field = 'desc'; mp.params.query = '超长续航'; mp.params.slop = '2';
bool.kids.must.push(m);
bool.kids.filter.push(t, r);
bool.kids.should.push(mp);

const dsl = Q.gen(bool);
eq('bool 生成', dsl, {
  bool: {
    must: [{ match: { title: { query: '智能手机', operator: 'AND', boost: 2 } } }],
    should: [{ match_phrase: { desc: { query: '超长续航', slop: 2 } } }],
    filter: [{ term: { status: { value: 1 } } }, { range: { price: { gte: 1000, lte: 5000 } } }],
    minimum_should_match: 1,
  },
});

// ---- 2. 往返：导入再生成 ----
const back = Q.importNode(dsl);
eq('bool 导入再生成一致', Q.gen(back), dsl);

// ---- 3. function_score + fn 子节点 ----
const fs = Q.mkNode('function_score');
fs.params.score_mode = 'sum';
fs.kids.query.push(Q.mkNode('match_all'));
const w = Q.mkNode('fn_weight'); w.params.weight = '3';
const dec = Q.mkNode('fn_decay');
dec.params.kind = 'gauss'; dec.params.field = 'publish_date'; dec.params.origin = 'now'; dec.params.scale = '7d'; dec.params.decay = '0.5';
fs.kids.functions.push(w, dec);
const fsDsl = Q.gen(fs);
eq('function_score 生成', fsDsl, {
  function_score: {
    query: { match_all: {} },
    functions: [
      { weight: 3 },
      { gauss: { publish_date: { origin: 'now', scale: '7d', decay: 0.5 } } },
    ],
    score_mode: 'sum',
  },
});
const fsBack = Q.importNode(fsDsl);
eq('function_score 导入再生成一致', Q.gen(fsBack), fsDsl);

// ---- 4. nested / knn / geo ----
const nested = Q.mkNode('nested');
nested.params.path = 'comments';
const nm = Q.mkNode('match'); nm.params.field = 'comments.text'; nm.params.query = '好用';
nested.kids.query.push(nm);
eq('nested 生成', Q.gen(nested), { nested: { path: 'comments', query: { match: { 'comments.text': { query: '好用' } } } } });
eq('nested 往返', Q.gen(Q.importNode(Q.gen(nested))), Q.gen(nested));

const knn = Q.mkNode('knn');
knn.params.field = 'embedding'; knn.params.query_vector = '0.1, 0.2, 0.3'; knn.params.k = '10'; knn.params.num_candidates = '100';
const kt = Q.mkNode('term'); kt.params.field = 'cat'; kt.params.value = 'phone';
knn.kids.filter.push(kt);
const knnDsl = Q.gen(knn);
eq('knn 生成', knnDsl, { knn: { field: 'embedding', k: 10, num_candidates: 100, filter: { term: { cat: { value: 'phone' } } }, query_vector: [0.1, 0.2, 0.3] } });
eq('knn 往返', Q.gen(Q.importNode(knnDsl)), knnDsl);

const gd = Q.mkNode('geo_distance');
gd.params.field = 'location'; gd.params.location = '31.23, 121.47'; gd.params.distance = '10km';
eq('geo_distance 生成', Q.gen(gd), { geo_distance: { location: '31.23, 121.47', distance: '10km' } });
eq('geo_distance 往返', Q.gen(Q.importNode(Q.gen(gd))), Q.gen(gd));

// ---- 5. terms / ids / multi_match ----
const terms = Q.mkNode('terms');
terms.params.field = 'brand'; terms.params.values = '华为\n小米,苹果';
eq('terms 生成', Q.gen(terms), { terms: { brand: ['华为', '小米', '苹果'] } });
eq('terms 往返', Q.gen(Q.importNode(Q.gen(terms))), Q.gen(terms));

const mm = Q.mkNode('multi_match');
mm.params.query = '手机'; mm.params.fields = 'title^3, content'; mm.params.type = 'best_fields';
eq('multi_match 生成', Q.gen(mm), { multi_match: { query: '手机', type: 'best_fields', fields: ['title^3', 'content'] } });
eq('multi_match 往返', Q.gen(Q.importNode(Q.gen(mm))), Q.gen(mm));

// ---- 6. span ----
const sn = Q.mkNode('span_near'); sn.params.slop = '3'; sn.params.in_order = 'true';
const s1 = Q.mkNode('span_term'); s1.params.field = 'text'; s1.params.value = '快速';
const s2 = Q.mkNode('span_term'); s2.params.field = 'text'; s2.params.value = '充电';
sn.kids.push(s1, s2);
const snDsl = Q.gen(sn);
eq('span_near 生成', snDsl, { span_near: { slop: 3, in_order: true, clauses: [{ span_term: { text: { value: '快速' } } }, { span_term: { text: { value: '充电' } } }] } });
eq('span_near 往返', Q.gen(Q.importNode(snDsl)), snDsl);

// ---- 7. script / intervals / 未知类型回退 raw ----
const sc = Q.mkNode('script');
sc.params.source = "doc['price'].value > params.min"; sc.params.params = '{"min": 100}';
eq('script 生成', Q.gen(sc), { script: { script: { source: "doc['price'].value > params.min", params: { min: 100 } } } });

const iv = Q.mkNode('intervals');
iv.params.field = 'body'; iv.params.mode = 'match'; iv.params.query = '华为手机'; iv.params.max_gaps = '2';
eq('intervals 生成', Q.gen(iv), { intervals: { body: { match: { query: '华为手机', max_gaps: 2 } } } });

const rawBack = Q.importNode({ some_future_query: { x: 1 } });
eq('未知类型回退 raw', Q.gen(rawBack), { some_future_query: { x: 1 } });

// ---- 8. 校验 ----
const bad = Q.mkNode('match'); // 缺 field/query
const issues = Q.validate(bad);
ok('校验捕获必填缺失', issues.length === 2, JSON.stringify(issues));
const badJson = Q.mkNode('script'); badJson.params.source = 'x'; badJson.params.params = '{bad';
ok('校验捕获 JSON 错误', Q.validate(badJson).length === 1);
ok('校验通过完整节点', Q.validate(m).length === 0);

// ---- 9. constant_score 多 filter 包装 ----
const cs = Q.mkNode('constant_score'); cs.params.boost = '1.5';
const c1 = Q.mkNode('term'); c1.params.field = 'a'; c1.params.value = '1';
const c2 = Q.mkNode('term'); c2.params.field = 'b'; c2.params.value = '2';
cs.kids.filter.push(c1, c2);
const csDsl = Q.gen(cs);
eq('constant_score 多 filter 包装 bool', csDsl, { constant_score: { filter: { bool: { filter: [{ term: { a: { value: 1 } } }, { term: { b: { value: 2 } } }] } }, boost: 1.5 } });
eq('constant_score 往返', Q.gen(Q.importNode(csDsl)), csDsl);

console.log(failed === 0 ? '\n全部通过' : '\n有 ' + failed + ' 项失败');
process.exit(failed === 0 ? 0 : 1);
