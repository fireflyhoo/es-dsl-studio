/* 索引管理相关核心逻辑测试：mapping 扁平化 / 格式化 / URL 与鉴权 / 响应解析 */
const E = require('../js/es-client.js');

let failed = 0;
function ok(name, cond, extra) {
  if (cond) console.log('PASS  ' + name);
  else { failed++; console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function eq(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(name, sa === sb, 'A=' + sa + ' B=' + sb);
}

// ---- 1. mapping 扁平化：多字段 / 嵌套对象 / 类型缺省 ----
const mappings = {
  properties: {
    title: { type: 'text', analyzer: 'ik_max_word', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
    price: { type: 'scaled_float', scaling_factor: 100 },
    created_at: { type: 'date', format: 'strict_date_optional_time||epoch_millis' },
    author: { properties: { name: { type: 'keyword' }, age: { type: 'integer' } } },
    tags: { type: 'keyword', index: false },
  },
};

const fields = E.flattenMapping(mappings);
eq('扁平化字段总数', fields.length, 8);
eq('字段路径顺序', fields.map((f) => f.path), [
  'title', 'title.keyword', 'price', 'created_at',
  'author', 'author.name', 'author.age', 'tags',
]);
eq('title 为 text 且带分词器', [fields[0].type, fields[0].analyzer], ['text', 'ik_max_word']);
ok('title.keyword 是多字段', fields[1].isMultiField === true && fields[1].depth === 1, JSON.stringify(fields[1]));
ok('author 无 type 时推断为 object 容器', fields[4].type === 'object' && fields[4].isContainer === true, JSON.stringify(fields[4]));
ok('嵌套字段 depth 递增', fields[5].depth === 1 && fields[5].path === 'author.name');
ok('index:false 被记录', fields[7].indexed === false);
eq('date 字段 format 保留', fields[3].format, 'strict_date_optional_time||epoch_millis');

// ---- 2. ES6 风格 mapping（多一层类型名） ----
const es6 = E.flattenMapping({ _doc: { properties: { a: { type: 'text' }, b: { type: 'long' } } } });
eq('ES6 mapping 兼容', es6.map((f) => f.path + ':' + f.type), ['a:text', 'b:long']);
eq('空 mapping 返回空数组', E.flattenMapping({}).length, 0);
eq('null mapping 不抛错', E.flattenMapping(null).length, 0);

// ---- 3. 类型统计（排除多字段） ----
const counts = E.typeCounts(fields);
const byType = Object.fromEntries(counts.map((c) => [c.type, c.count]));
eq('keyword 统计（含多字段）', byType.keyword, 3);
eq('text 统计', byType.text, 1);
eq('object 统计', byType.object, 1);
eq('分布之和等于字段总数', counts.reduce((s, c) => s + c.count, 0), fields.length);

// ---- 4. 字段过滤 ----
eq('按关键字过滤', E.filterFields(fields, 'author', 'all').map((f) => f.path), ['author', 'author.name', 'author.age']);
eq('按类型过滤', E.filterFields(fields, '', 'keyword').map((f) => f.path), ['title.keyword', 'author.name', 'tags']);
eq('关键字+类型组合', E.filterFields(fields, 'name', 'keyword').map((f) => f.path), ['author.name']);

// ---- 5. 格式化 ----
eq('bytes 0', E.formatBytes(0), '0 B');
eq('bytes 1024', E.formatBytes(1024), '1.00 KB');
eq('bytes 1536', E.formatBytes(1536), '1.50 KB');
eq('bytes 12MB', E.formatBytes(12 * 1024 * 1024), '12.0 MB');
eq('bytes null', E.formatBytes(null), '—');
eq('count 9999', E.formatCount(9999), '9,999');
eq('count 12345', E.formatCount(12345), '1.23 万');
eq('count 1234567', E.formatCount(1234567), '123.5 万');
eq('count 123456789', E.formatCount(123456789), '1.23 亿');

// ---- 6. URL 与鉴权 ----
eq('trimUrl 去尾斜杠', E.trimUrl('http://a:9200///'), 'http://a:9200');
eq('joinUrl 拼接', E.joinUrl('http://a:9200/', '/x/_mapping'), 'http://a:9200/x/_mapping');
eq('joinUrl 无前导斜杠', E.joinUrl('http://a:9200', 'x'), 'http://a:9200/x');
eq('hostOf', E.hostOf('https://es.example.com:9200/prefix'), 'es.example.com:9200/prefix');

const bh = E.authHeaders({ authType: 'basic', username: 'u', password: 'p' });
eq('basic 鉴权头', bh.Authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
eq('apikey 鉴权头', E.authHeaders({ authType: 'apikey', apiKey: ' abc ' }).Authorization, 'ApiKey abc');
eq('bearer 鉴权头', E.authHeaders({ authType: 'bearer', token: 't0k' }).Authorization, 'Bearer t0k');
eq('无认证不带头', Object.keys(E.authHeaders({ authType: 'none' })).length, 0);

// ---- 7. _cat 响应归一化 ----
const rows = E.normalizeCatRows([
  { index: 'b', health: 'green', status: 'open', pri: '3', rep: '1', 'docs.count': '10', 'store.size': '1024' },
  { index: 'a', health: 'yellow', status: 'open', pri: '1', rep: '0', 'docs.count': '', 'store.size': '' },
  { index: '.kibana', health: 'green' },
]);
eq('按名称排序', rows.map((r) => r.index), ['.kibana', 'a', 'b']);
ok('数值被转换', rows[2].docs === 10 && rows[2].sizeBytes === 1024 && rows[2].shards === 3, JSON.stringify(rows[2]));
ok('空字符串转 null', rows[1].docs === null && rows[1].sizeBytes === null, JSON.stringify(rows[1]));

// ---- 8. 详情解析 ----
const detail = E.parseDetail({
  mapping: { products: { mappings: { properties: { sku: { type: 'keyword' }, name: { type: 'text' } } } } },
  settings: { products: { settings: { index: { number_of_shards: '3', number_of_replicas: '1', uuid: 'abc123', creation_date: '1700000000000', version: { created: '8100099' } } } } },
  aliases: { products: { aliases: { products_live: { is_write_index: true } } } },
}, 'products');

eq('详情索引名', detail.index, 'products');
eq('详情字段数', detail.fields.length, 2);
eq('别名解析', Object.keys(detail.aliases), ['products_live']);
const summary = E.indexSettingsSummary(detail.settings);
eq('设置摘要 shards', summary.shards, '3');
eq('设置摘要 replicas', summary.replicas, '1');
eq('设置摘要 uuid', summary.uuid, 'abc123');
eq('设置摘要创建时间', summary.creationDate, 1700000000000);
eq('设置摘要版本', summary.version, '8100099');

// ---- 9. ES 设置值可能是数组 ----
const arrSummary = E.indexSettingsSummary({ index: { number_of_shards: ['5'], number_of_replicas: ['2'] } });
eq('数组形式的设置值', [arrSummary.shards, arrSummary.replicas], ['5', '2']);

// ---- 10. CORS 报错识别 ----
ok('识别 Failed to fetch', E.isCorsLike({ kind: 'network', message: '无法直连：Failed to fetch' }) === true);
ok('非网络错误不误判', E.isCorsLike({ kind: 'http', message: 'Elasticsearch 返回 404' }) === false);

// ---- 11. 索引名编码 ----
eq('索引名编码保留通配符', E.encIndex('logs-*'), 'logs-*');
eq('索引名编码空格', E.encIndex('a b'), 'a%20b');

// ---- 12. 文档展平（查询结果表格） ----
const doc = E.flattenDoc({
  title: '无线鼠标',
  price: 99.5,
  author: { name: '张三', age: 31 },
  tags: ['电子', '外设'],
  nested: [{ a: 1 }],
  empty: {},
  nothing: null,
  zero: 0,
  flag: false,
});
eq('展平-标题', doc.title, '无线鼠标');
eq('展平-数值保留类型', doc.price, 99.5);
eq('展平-嵌套对象用点连接', doc['author.name'], '张三');
eq('展平-数组转 JSON', doc.tags, '["电子","外设"]');
eq('展平-对象数组摘要', JSON.stringify(doc.nested), '["{…}"]');
eq('展平-空对象', doc.empty, '{}');
eq('展平-null 保留', doc.nothing, null);
eq('展平-0 不被吞掉', doc.zero, 0);
eq('展平-false 不被吞掉', doc.flag, false);
eq('展平-键数量', Object.keys(doc).length, 10);
eq('展平-空对象输入', JSON.stringify(E.flattenDoc({})), '{"":"{}"}');
eq('展平-多级嵌套', E.flattenDoc({ a: { b: { c: 1 } } })['a.b.c'], 1);

// ---- 13. 聚合拍平 ----
const aggs = E.aggRows({
  by_tag: {
    buckets: [
      { key: '电子', doc_count: 2 },
      { key: '外设', doc_count: 1, avg_price: { value: 99.5 } },
    ],
  },
  by_date: { buckets: [{ key_as_string: '2026-10-01', key: 1, doc_count: 5 }] },
  max_price: { value: 399 },
});
eq('聚合-行数', aggs.length, 5);
eq('聚合-首行聚合名', aggs[0].agg, 'by_tag');
eq('聚合-首行 key', aggs[0].key, '电子');
eq('聚合-首行计数', aggs[0].count, 2);
eq('聚合-子聚合聚合名', aggs[2].agg, 'by_tag › avg_price');
eq('聚合-子聚合取值', aggs[2].key, '99.5');
eq('聚合-日期桶聚合名', aggs[3].agg, 'by_date');
eq('聚合-指标聚合', aggs[4].agg, 'max_price');
eq('聚合-指标聚合值', aggs[4].key, '399');
eq('聚合-key_as_string 优先', E.aggRows({ d: { buckets: [{ key_as_string: '2026-10-01', key: 1, doc_count: 5 }] } })[0].key, '2026-10-01');
eq('聚合-无聚合返回空数组', E.aggRows(undefined).length, 0);

// ---- 14. cellText ----
eq('cellText-数字', E.cellText(0), '0');
eq('cellText-null', E.cellText(null), '');
eq('cellText-对象', E.cellText({ a: 1 }), '{"a":1}');
eq('cellText-布尔', E.cellText(false), 'false');

console.log(failed === 0 ? '\n全部通过' : '\n有 ' + failed + ' 项失败');
process.exit(failed === 0 ? 0 : 1);
