/* 聚合统计回归：生成 -> 导入往返 -> 校验 -> 结果整形 */
const Q = require('../web/js/queries.js');
const E = require('../web/js/es-client.js');

let failed = 0;
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

// 便捷构造：mkNode + 填参数
function mk(type, params, kids) {
  const n = Q.mkNode(type);
  Object.assign(n.params, params || {});
  if (kids) Object.keys(kids).forEach((k) => { n.kids[k] = kids[k]; });
  return n;
}

/* ---- 1. 指标聚合生成（单节点产出聚合体，名称由容器层包裹） ---- */
eq('avg 生成', Q.gen(mk('agg_avg', { name: 'avg_price', field: 'price', missing: '0' })),
  { avg: { field: 'price', missing: 0 } });
eq('sum 生成', Q.gen(mk('agg_sum', { name: 'total', field: 'amount' })),
  { sum: { field: 'amount' } });
eq('min/max 生成', Q.gen(mk('agg_min', { name: 'lo', field: 'price' })),
  { min: { field: 'price' } });
eq('cardinality 生成', Q.gen(mk('agg_cardinality', { name: 'uv', field: 'user_id', precision_threshold: '1000' })),
  { cardinality: { field: 'user_id', precision_threshold: 1000 } });
eq('value_count 生成', Q.gen(mk('agg_value_count', { name: 'vc', field: 'tags' })),
  { value_count: { field: 'tags' } });
eq('stats 生成', Q.gen(mk('agg_stats', { name: 'st', field: 'price' })),
  { stats: { field: 'price' } });
eq('extended_stats 生成', Q.gen(mk('agg_extended_stats', { name: 'es', field: 'price', sigma: '3' })),
  { extended_stats: { field: 'price', sigma: 3 } });
eq('percentiles 生成', Q.gen(mk('agg_percentiles', { name: 'pct', field: 'latency', percents: '50, 95, 99', keyed: 'true' })),
  { percentiles: { field: 'latency', percents: [50, 95, 99], keyed: true } });
eq('weighted_avg 生成', Q.gen(mk('agg_weighted_avg', { name: 'wavg', value_field: 'price', weight_field: 'stock', value_factor: '1.5' })),
  { weighted_avg: { value: { field: 'price', factor: 1.5 }, weight: { field: 'stock' } } });

/* ---- 2. 桶聚合生成 ---- */
eq('terms 生成', Q.gen(mk('agg_terms', { name: 'by_status', field: 'status.keyword', size: '5', order: '_count desc', min_doc_count: '2', missing: 'N/A' })),
  { terms: { field: 'status.keyword', size: 5, order: { _count: 'desc' }, min_doc_count: 2, missing: 'N/A' } });
eq('date_histogram 生成（interval 全版本兼容）', Q.gen(mk('agg_date_histogram', { name: 'trend', field: '@timestamp', interval: '1h', format: 'yyyy-MM-dd', time_zone: '+08:00' })),
  { date_histogram: { field: '@timestamp', interval: '1h', format: 'yyyy-MM-dd', time_zone: '+08:00' } });
eq('date_histogram 默认 1d', Q.gen(mk('agg_date_histogram', { name: 'trend', field: '@timestamp' })),
  { date_histogram: { field: '@timestamp', interval: '1d' } });
eq('histogram 生成', Q.gen(mk('agg_histogram', { name: 'dist', field: 'price', interval: '100', min_doc_count: '1' })),
  { histogram: { field: 'price', interval: 100, min_doc_count: 1 } });
eq('range 生成', Q.gen(mk('agg_range', { name: 'r', field: 'price', ranges: '[{"to":100},{"from":100,"to":500},{"from":500}]' })),
  { range: { field: 'price', ranges: [{ to: 100 }, { from: 100, to: 500 }, { from: 500 }] } });
eq('date_range 生成', Q.gen(mk('agg_date_range', { name: 'dr', field: 'ts', format: 'yyyy-MM-dd', ranges: '[{"to":"now-7d"},{"from":"now-7d"}]' })),
  { date_range: { field: 'ts', format: 'yyyy-MM-dd', ranges: [{ to: 'now-7d' }, { from: 'now-7d' }] } });
eq('filters 生成', Q.gen(mk('agg_filters', { name: 'lv', filters: '{"错误":{"term":{"level":"error"}}}' })),
  { filters: { 错误: { term: { level: 'error' } } } });
eq('nested 生成', Q.gen(mk('agg_nested', { name: 'cm', path: 'comments' })),
  { nested: { path: 'comments' } });
eq('missing 生成', Q.gen(mk('agg_missing', { name: 'mi', field: 'phone' })),
  { missing: { field: 'phone' } });
eq('global 生成', Q.gen(mk('agg_global', { name: 'all' })), { global: {} });

/* ---- 3. filter 聚合：查询子节点 ---- */
const flt = mk('agg_filter', { name: 'ok' });
flt.kids.filter.push(mk('term', { field: 'level', value: 'ok' }));
eq('filter 聚合生成', Q.gen(flt), { filter: { term: { level: { value: 'ok' } } } });

/* ---- 4. 嵌套子聚合：terms > date_histogram > avg ---- */
const nested = mk('aggs', {}, {});
const inner = mk('agg_avg', { name: 'avg_price', field: 'price' });
const dh = mk('agg_date_histogram', { name: 'per_day', field: '@timestamp', interval: '1d' }, { sub: [inner] });
const terms = mk('agg_terms', { name: 'by_cat', field: 'category.keyword', size: '3' }, { sub: [dh] });
nested.kids.push(terms);
const nestedDsl = Q.gen(nested);
eq('嵌套聚合生成', nestedDsl, {
  by_cat: {
    terms: { field: 'category.keyword', size: 3 },
    aggs: {
      per_day: {
        date_histogram: { field: '@timestamp', interval: '1d' },
        aggs: { avg_price: { avg: { field: 'price' } } },
      },
    },
  },
});

/* ---- 5. 导入往返 ---- */
const back = Q.importAggs(nestedDsl);
ok('importAggs 返回容器', back && back.type === 'aggs' && back.kids.length === 1);
// 必须识别成具体聚合类型，而不是全部落进 agg_raw 兜底
ok('terms 识别为 agg_terms', back.kids[0].type === 'agg_terms', back.kids[0].type);
ok('子聚合识别为 agg_date_histogram', back.kids[0].kids.sub[0].type === 'agg_date_histogram', back.kids[0].kids.sub[0].type);
ok('孙聚合识别为 agg_avg', back.kids[0].kids.sub[0].kids.sub[0].type === 'agg_avg', back.kids[0].kids.sub[0].kids.sub[0].type);
eq('嵌套聚合导入再生成一致', Q.gen(back), nestedDsl);
eq('单个聚合导入往返', Q.gen(Q.importAggs(Q.gen(flt))), Q.gen(flt));
eq('percentiles 导入往返', Q.gen(Q.importAggs(Q.gen(mk('agg_percentiles', { name: 'p', field: 'x', percents: '25,50' })))),
  Q.gen(mk('agg_percentiles', { name: 'p', field: 'x', percents: '25,50' })));

/* ---- 5b. 每种聚合类型都能被导入识别（DSL 键名 -> agg_ 类型名） ---- */
const ALL_AGG_TYPES = ['avg', 'sum', 'min', 'max', 'cardinality', 'value_count', 'stats', 'extended_stats',
  'percentiles', 'weighted_avg', 'terms', 'date_histogram', 'histogram', 'range', 'date_range',
  'filters', 'nested', 'missing', 'global', 'filter'];
ALL_AGG_TYPES.forEach((t) => {
  const node = mk('agg_' + t, {
    name: 'x', field: 'f', interval: '1d', path: 'p', percents: '50',
    value_field: 'a', weight_field: 'b', ranges: '[{"to":1}]', filters: '{"a":{"match_all":{}}}',
  });
  if (t === 'filter') node.kids.filter.push(mk('match_all', {}));
  const dsl = { x: Q.gen(node) };
  const b2 = Q.importAggs(dsl);
  ok('导入识别 ' + t, !!(b2 && b2.kids[0] && b2.kids[0].type === 'agg_' + t), b2 && b2.kids[0] ? b2.kids[0].type : 'null');
});

/* ---- 6. 未知聚合 -> agg_raw 兜底，不丢数据 ---- */
const rawIn = Q.importAggs({ scripted: { scripted_metric: { init_script: 'state.docs = 0' } } });
ok('未知聚合落入 agg_raw', rawIn.kids[0].type === 'agg_raw' && rawIn.kids[0].params.name === 'scripted');
eq('agg_raw 原样输出', Q.gen(rawIn), { scripted: { scripted_metric: { init_script: 'state.docs = 0' } } });

/* ---- 7. 校验 ---- */
ok('完整聚合无问题', Q.validate(nested, 'aggs').length === 0, JSON.stringify(Q.validate(nested, 'aggs')));
ok('缺字段报错', Q.validate(mk('agg_terms', { name: 't' }), 'aggs').some((i) => i.indexOf('缺少必填项') !== -1));
ok('缺名称报错', Q.validate(mk('agg_avg', { field: 'p' }), 'aggs').some((i) => i.indexOf('名称') !== -1));
const dup = Q.mkNode('aggs');
dup.kids.push(mk('agg_avg', { name: 'x', field: 'a' }), mk('agg_sum', { name: 'x', field: 'b' }));
ok('同名聚合报错', Q.validate(dup, 'aggs').some((i) => i.indexOf('重复') !== -1));
ok('date_histogram 缺 interval 报错', Q.validate(mk('agg_date_histogram', { name: 'd', field: 'ts', interval: '' }), 'aggs').some((i) => i.indexOf('interval') !== -1));
ok('非法 ranges JSON 报错', Q.validate(mk('agg_range', { name: 'r', field: 'p', ranges: '[{broken' }), 'aggs').some((i) => i.indexOf('JSON') !== -1));
ok('空聚合容器无问题', Q.validate(Q.mkNode('aggs'), 'aggs').length === 0);
ok('importAggs(null) 返回 null', Q.importAggs(null) === null);

/* ---- 8. 结果整形：aggMetricList ---- */
const respAggs = {
  avg_price: { value: 328.5 },
  total: { value: 12345, value_as_string: '12345' },
  st: { count: 100, min: 1, max: 999, avg: 50.5, sum: 5050 },
  pct: { values: { '1.0': 5, '50.0': 88, '99.0': 420 } },
  by_status: { buckets: [{ key: 'ok', doc_count: 10 }, { key: 'err', doc_count: 3 }] },
  meta_only: { meta: { x: 1 } },
};
const cards = E.aggMetricList(respAggs);
eq('指标卡片集合', cards.map((c) => c.name), ['avg_price', 'total', 'st', 'pct']);
eq('单值卡片', cards[0].values, [{ k: 'value', v: 328.5 }]);
eq('value_as_string 优先', cards[1].values, [{ k: 'value', v: '12345' }]);
eq('stats 卡片键序', cards[2].values.map((v) => v.k), ['count', 'min', 'max', 'avg', 'sum']);
eq('percentiles 卡片', cards[3].values, [{ k: 'P1.0', v: 5 }, { k: 'P50.0', v: 88 }, { k: 'P99.0', v: 420 }]);
eq('aggMetricList 空输入', E.aggMetricList(null), []);

/* ---- 9. 结果整形：aggRows 拍平 ---- */
const flat = E.aggRows({
  by_status: {
    buckets: [
      { key: 'ok', doc_count: 10, avg_price: { value: 30 } },
      { key: 'err', doc_count: 3, avg_price: { value: 90 } },
    ],
  },
});
eq('aggRows 拍平行数', flat.length, 4);
eq('aggRows 桶键与指标值', flat.map((r) => r.key), ['ok', '30', 'err', '90']);
eq('aggRows 子指标路径', flat[1].agg, 'by_status › avg_price');

console.log(failed ? '\n共 ' + failed + ' 项失败' : '\n全部通过');
process.exit(failed ? 1 : 0);
