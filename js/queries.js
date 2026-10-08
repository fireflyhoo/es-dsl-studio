/* ============================================================
 * ES DSL Studio - 查询语法核心模块
 * 查询类型定义 / 树 -> DSL JSON 生成 / DSL JSON -> 树 导入 / 校验
 * 纯逻辑，无 DOM 依赖，可在 Node 中直接测试。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 分类 ---------------- */
  const CATS = [
    { id: 'compound', label: '组合查询',   en: 'Compound',        color: '#ea580c' },
    { id: 'fulltext', label: '全文检索',   en: 'Full text',       color: '#0d9488' },
    { id: 'termq',    label: '词项查询',   en: 'Term level',      color: '#2563eb' },
    { id: 'geo',      label: '地理位置',   en: 'Geo',             color: '#16a34a' },
    { id: 'join',     label: '嵌套 / 父子', en: 'Joining',        color: '#e11d48' },
    { id: 'vector',   label: '向量检索',   en: 'Vector',          color: '#4f46e5' },
    { id: 'span',     label: 'Span 查询',  en: 'Span',            color: '#0e7490' },
    { id: 'special',  label: '特殊查询',   en: 'Specialized',     color: '#d97706' },
    { id: 'fn',       label: '评分函数',   en: 'Score functions', color: '#be185d' },
    { id: 'custom',   label: '自定义',     en: 'Custom',          color: '#64748b' },
  ];
  const CATMAP = Object.fromEntries(CATS.map(c => [c.id, c]));

  /* ---------------- 工具 ---------------- */
  let _seq = 1;
  function uid() { return 'n' + (_seq++) + '_' + Math.random().toString(36).slice(2, 7); }

  function isEmpty(v) { return v === undefined || v === null || v === ''; }

  // 字符串自动转 number / boolean
  function coerce(v) {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (t === '') return v;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
    return v;
  }

  // "a, b" 或 换行分隔 -> 数组（元素自动转型）
  function csv(v) {
    if (Array.isArray(v)) return v;
    return String(v).split(/[\n,，]+/).map(s => s.trim()).filter(Boolean).map(coerce);
  }

  // 尝试解析 JSON 字符串；空->undefined；失败->fallback
  function tryJSON(v, fallback) {
    if (isEmpty(v)) return undefined;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }

  // 收集 params 中非空且不在 skip 列表里的键（自动转型）
  function restParams(n, skip) {
    const o = {};
    for (const k of Object.keys(n.params)) {
      if (skip.indexOf(k) !== -1) continue;
      const v = n.params[k];
      if (isEmpty(v)) continue;
      o[k] = coerce(v);
    }
    return o;
  }

  /* ---------------- 通用构建器 ---------------- */
  // match / term / prefix / wildcard / regexp / fuzzy / span_term 等
  // 结构: { <type>: { <field>: { <valueKey>: v, ...opts } } }
  function fqBuild(n) {
    const def = DEFS[n.type];
    const p = n.params;
    const f = isEmpty(p.field) ? '?field?' : p.field;
    const o = {};
    for (const k of Object.keys(p)) {
      if (k === 'field' || isEmpty(p[k])) continue;
      o[k] = coerce(p[k]);
    }
    return { [n.type]: { [f]: o } };
  }

  // fq 反向解析
  function fqFrom(body, n) {
    const def = DEFS[n.type];
    const keys = Object.keys(body || {});
    if (!keys.length) return;
    const f = keys[0];
    n.params.field = f;
    const inner = body[f];
    if (inner === null || typeof inner !== 'object') {
      n.params[def.valueKey || 'value'] = String(inner);
      return;
    }
    for (const k of Object.keys(inner)) {
      const v = inner[k];
      n.params[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
    }
  }

  // 槽位容器构建：{ type: { slotA: [...], slotB: {...}, ...rest } }
  function slotsBuild(type) {
    return function (n) {
      const def = DEFS[type];
      const o = {};
      for (const s of def.slots) {
        const kids = (n.kids[s.key] || []).map(gen).filter(Boolean);
        if (!kids.length) continue;
        o[s.key] = s.multi ? kids : kids[0];
      }
      Object.assign(o, restParams(n, []));
      return { [type]: o };
    };
  }

  // 列表容器构建：{ type: { <listKey>: [...], ...rest } }
  function listBuild(type, listKey) {
    return function (n) {
      const o = {};
      const kids = (n.kids || []).map(gen).filter(Boolean);
      if (kids.length) o[listKey] = kids;
      Object.assign(o, restParams(n, []));
      return { [type]: o };
    };
  }

  // 通用 fromJson：把 body 中等于字段名的键拷回 params
  function genericFrom(body, n) {
    const def = DEFS[n.type];
    const fieldKeys = def.fields.map(f => f.k);
    for (const k of Object.keys(body || {})) {
      if (fieldKeys.indexOf(k) === -1) continue;
      const v = body[k];
      n.params[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
    }
  }

  /* ---------------- 查询类型定义 ---------------- */
  const BOOST = { k: 'boost', label: 'boost 权重', kind: 'number', ph: '1.0' };
  const F = (k, label, kind, extra) => Object.assign({ k, label, kind: kind || 'text' }, extra || {});
  const SEL = (v, extra) => Object.assign({ kind: 'select', opts: v }, extra || {});

  const DEFS = {};

  function def(d) { DEFS[d.type] = d; }

  /* ===== 组合查询 ===== */
  def({
    type: 'bool', cat: 'compound', cn: '布尔组合', valueKey: null,
    desc: 'must / should / must_not / filter 四类子句组合，最常用的复合查询。',
    fields: [
      F('minimum_should_match', 'minimum_should_match', 'text', { ph: '如 1 或 60%', help: 'should 子句最少匹配数' }),
      BOOST,
    ],
    slots: [
      { key: 'must',     label: 'must · 必须满足',        multi: true,  color: '#0d9488' },
      { key: 'should',   label: 'should · 可选加分',       multi: true,  color: '#d97706' },
      { key: 'must_not', label: 'must_not · 必须不满足',   multi: true,  color: '#dc2626' },
      { key: 'filter',   label: 'filter · 过滤(不计分)',   multi: true,  color: '#2563eb' },
    ],
    build: slotsBuild('bool'),
    fromJson(body, n) {
      for (const s of ['must', 'should', 'must_not', 'filter']) {
        const arr = body[s];
        if (!arr) continue;
        const list = Array.isArray(arr) ? arr : [arr];
        n.kids[s] = list.map(importNode).filter(Boolean);
      }
      genericFrom(body, n);
    },
    summary(n) {
      const c = ['must', 'should', 'must_not', 'filter'].map(s => (n.kids[s] || []).length);
      return `must:${c[0]} should:${c[1]} not:${c[2]} filter:${c[3]}`;
    },
  });

  def({
    type: 'dis_max', cat: 'compound', cn: '分离最大化',
    desc: '任一子查询匹配即命中，取最高分，tie_breaker 可叠加其他子查询分数。',
    fields: [F('tie_breaker', 'tie_breaker', 'number', { ph: '0.0' }), BOOST],
    listKids: { key: 'queries', label: 'queries · 子查询列表' },
    build: listBuild('dis_max', 'queries'),
    fromJson(body, n) {
      n.kids = (body.queries || []).map(importNode).filter(Boolean);
      genericFrom(body, n);
    },
  });

  def({
    type: 'constant_score', cat: 'compound', cn: '常量评分',
    desc: '包裹 filter 查询，所有命中文档得分固定为 boost，常用于不计分场景。',
    fields: [BOOST],
    slots: [{ key: 'filter', label: 'filter · 过滤条件', multi: true, color: '#2563eb' }],
    build(n) {
      const kids = (n.kids.filter || []).map(gen).filter(Boolean);
      const o = restParams(n, []);
      if (kids.length === 1) o.filter = kids[0];
      else if (kids.length > 1) o.filter = { bool: { filter: kids } };
      return { constant_score: o };
    },
    fromJson(body, n) {
      if (body.filter) {
        const inner = body.filter;
        if (inner.bool && Array.isArray(inner.bool.filter)) {
          n.kids.filter = inner.bool.filter.map(importNode).filter(Boolean);
        } else {
          n.kids.filter = [importNode(inner)].filter(Boolean);
        }
      }
      genericFrom(body, n);
    },
  });

  def({
    type: 'function_score', cat: 'compound', cn: '函数评分',
    desc: '用一组评分函数改写文档得分，可叠加 weight / random / 衰减等函数。',
    fields: [
      F('score_mode', 'score_mode 函数间合成', 'select', { opts: ['multiply', 'sum', 'avg', 'first', 'max', 'min'] }),
      F('boost_mode', 'boost_mode 与原始分合成', 'select', { opts: ['multiply', 'replace', 'sum', 'avg', 'max', 'min'] }),
      F('max_boost', 'max_boost', 'number'), F('min_score', 'min_score', 'number'), BOOST,
    ],
    slots: [
      { key: 'query',     label: 'query · 基础查询',        multi: false, color: '#64748b' },
      { key: 'functions', label: 'functions · 评分函数',    multi: true,  color: '#be185d', accept: 'fn' },
    ],
    build(n) {
      const o = {};
      const q = (n.kids.query || []).map(gen).filter(Boolean)[0];
      if (q) o.query = q;
      const fns = (n.kids.functions || []).map(gen).filter(Boolean);
      if (fns.length) o.functions = fns;
      Object.assign(o, restParams(n, []));
      return { function_score: o };
    },
    fromJson(body, n) {
      if (body.query) n.kids.query = [importNode(body.query)].filter(Boolean);
      n.kids.functions = (body.functions || []).map(importNode).filter(Boolean);
      genericFrom(body, n);
    },
  });

  def({
    type: 'boosting', cat: 'compound', cn: '正负加权',
    desc: 'positive 查询命中的文档中，同时命中 negative 的按 negative_boost 降权。',
    fields: [F('negative_boost', 'negative_boost *', 'number', { req: true, ph: '0.5' })],
    slots: [
      { key: 'positive', label: 'positive · 正向查询', multi: false, color: '#0d9488' },
      { key: 'negative', label: 'negative · 负向查询', multi: false, color: '#dc2626' },
    ],
    build: slotsBuild('boosting'),
    fromJson(body, n) {
      if (body.positive) n.kids.positive = [importNode(body.positive)].filter(Boolean);
      if (body.negative) n.kids.negative = [importNode(body.negative)].filter(Boolean);
      genericFrom(body, n);
    },
  });

  /* ===== 全文检索 ===== */
  const MATCH_EXTRA = [
    F('operator', 'operator', 'select', { opts: ['OR', 'AND'] }),
    F('minimum_should_match', 'minimum_should_match', 'text', { ph: '如 2 或 75%' }),
    F('fuzziness', 'fuzziness 模糊度', 'text', { ph: 'AUTO / 1 / 2' }),
    F('analyzer', 'analyzer 分析器'), F('zero_terms_query', 'zero_terms_query', 'select', { opts: ['none', 'all'] }),
    F('lenient', 'lenient 忽略类型错误', 'checkbox'), BOOST,
  ];
  function fieldQ(type, cn, valueKey, fields, desc) {
    def({
      type, cat: 'fulltext', cn, valueKey, desc,
      fields: [F('field', '字段名 *', 'text', { req: true, ph: '如 title' }),
               F(valueKey, valueKey === 'query' ? '查询文本 *' : '值 *', 'text', { req: true })].concat(fields),
      build: fqBuild, fromJson: fqFrom,
      summary(n) { return (n.params.field || '?') + ' = "' + (n.params[valueKey] || '') + '"'; },
    });
  }
  fieldQ('match', '全文匹配', 'query', MATCH_EXTRA,
    '最常用全文查询：先分词再匹配，支持模糊、操作符等。');
  fieldQ('match_phrase', '短语匹配', 'query', [
    F('slop', 'slop 词距', 'number', { ph: '0' }), F('analyzer', 'analyzer'), F('zero_terms_query', 'zero_terms_query', 'select', { opts: ['none', 'all'] }), BOOST,
  ], '分词后按顺序短语匹配，slop 允许词间跳位。');
  fieldQ('match_phrase_prefix', '短语前缀匹配', 'query', [
    F('slop', 'slop', 'number'), F('max_expansions', 'max_expansions', 'number', { ph: '50' }), F('analyzer', 'analyzer'), BOOST,
  ], '短语匹配 + 最后一个词当前缀，常用于搜索建议。');
  fieldQ('match_bool_prefix', '布尔前缀匹配', 'query', [
    F('operator', 'operator', 'select', { opts: ['OR', 'AND'] }), F('minimum_should_match', 'minimum_should_match'),
    F('fuzziness', 'fuzziness'), F('analyzer', 'analyzer'), BOOST,
  ], '除最后一个词按前缀外，其余按 term 布尔组合，适合输入即搜。');

  def({
    type: 'multi_match', cat: 'fulltext', cn: '多字段匹配', valueKey: 'query',
    desc: '一个查询词同时匹配多个字段，字段可用 ^ 加权（title^3）。',
    fields: [
      F('query', '查询文本 *', 'text', { req: true }),
      F('fields', '字段列表 *', 'text', { req: true, ph: 'title^3, content, tags' }),
      F('type', 'type', 'select', { opts: ['best_fields', 'most_fields', 'cross_fields', 'phrase', 'phrase_prefix', 'bool_prefix'] }),
      F('operator', 'operator', 'select', { opts: ['OR', 'AND'] }),
      F('tie_breaker', 'tie_breaker', 'number'), F('minimum_should_match', 'minimum_should_match'),
      F('fuzziness', 'fuzziness'), F('analyzer', 'analyzer'), BOOST,
    ],
    build(n) {
      const o = restParams(n, ['fields']);
      if (!isEmpty(n.params.fields)) o.fields = csv(n.params.fields);
      return { multi_match: o };
    },
    fromJson(body, n) {
      genericFrom(body, n);
      if (Array.isArray(body.fields)) n.params.fields = body.fields.join(', ');
    },
    summary(n) { return '"' + (n.params.query || '') + '" in [' + (n.params.fields || '?') + ']'; },
  });

  def({
    type: 'combined_fields', cat: 'fulltext', cn: '合并字段匹配', valueKey: 'query',
    desc: '把多个字段当作一个合并字段打分（跨字段词频），适合 cross_fields 场景。',
    fields: [
      F('query', '查询文本 *', 'text', { req: true }),
      F('fields', '字段列表 *', 'text', { req: true, ph: 'title, content' }),
      F('operator', 'operator', 'select', { opts: ['or', 'and'] }),
      F('auto_generate_synonyms_phrase_query', '同义词短语', 'checkbox'),
      F('minimum_should_match', 'minimum_should_match'), F('zero_terms_query', 'zero_terms_query', 'select', { opts: ['none', 'all'] }), BOOST,
    ],
    build(n) {
      const o = restParams(n, ['fields']);
      if (!isEmpty(n.params.fields)) o.fields = csv(n.params.fields);
      return { combined_fields: o };
    },
    fromJson(body, n) { genericFrom(body, n); if (Array.isArray(body.fields)) n.params.fields = body.fields.join(', '); },
  });

  def({
    type: 'query_string', cat: 'fulltext', cn: '查询字符串', valueKey: 'query',
    desc: '支持 Lucene 语法（AND/OR/NOT、字段:值、通配），功能强但容错低。',
    fields: [
      F('query', '查询表达式 *', 'text', { req: true, ph: 'title:手机 AND price:[1000 TO 5000]' }),
      F('fields', '字段列表', 'text', { ph: 'title, content' }),
      F('default_field', 'default_field'), F('default_operator', 'default_operator', 'select', { opts: ['AND', 'OR'] }),
      F('analyzer', 'analyzer'), F('allow_leading_wildcard', '允许前导通配符', 'checkbox'),
      F('analyze_wildcard', '分析通配词', 'checkbox'), F('lenient', 'lenient', 'checkbox'),
      F('minimum_should_match', 'minimum_should_match'), F('fuzziness', 'fuzziness'),
      F('phrase_slop', 'phrase_slop', 'number'), F('tie_breaker', 'tie_breaker', 'number'),
      F('time_zone', 'time_zone', 'text', { ph: '+08:00' }), BOOST,
    ],
    build(n) {
      const o = restParams(n, ['fields']);
      if (!isEmpty(n.params.fields)) o.fields = csv(n.params.fields);
      return { query_string: o };
    },
    fromJson(body, n) { genericFrom(body, n); if (Array.isArray(body.fields)) n.params.fields = body.fields.join(', '); },
    summary(n) { return String(n.params.query || ''); },
  });

  def({
    type: 'simple_query_string', cat: 'fulltext', cn: '简版查询字符串', valueKey: 'query',
    desc: '简化版 query_string，语法错误不会抛异常，适合直接暴露给终端用户。',
    fields: [
      F('query', '查询表达式 *', 'text', { req: true, ph: '手机 +华为 -二手' }),
      F('fields', '字段列表', 'text'), F('default_operator', 'default_operator', 'select', { opts: ['or', 'and'] }),
      F('analyzer', 'analyzer'), F('flags', 'flags', 'text', { ph: 'OR|AND|PREFIX' }),
      F('lenient', 'lenient', 'checkbox'), F('minimum_should_match', 'minimum_should_match'),
      F('fuzzy_max_expansions', 'fuzzy_max_expansions', 'number'), BOOST,
    ],
    build(n) {
      const o = restParams(n, ['fields']);
      if (!isEmpty(n.params.fields)) o.fields = csv(n.params.fields);
      return { simple_query_string: o };
    },
    fromJson(body, n) { genericFrom(body, n); if (Array.isArray(body.fields)) n.params.fields = body.fields.join(', '); },
    summary(n) { return String(n.params.query || ''); },
  });

  def({
    type: 'intervals', cat: 'fulltext', cn: '词距查询', valueKey: 'query',
    desc: '按词项出现顺序与间隔精细匹配，match/all_of/any_of 可嵌套。',
    fields: [
      F('field', '字段名 *', 'text', { req: true }),
      F('mode', '模式', 'select', { opts: ['match', 'prefix', 'wildcard', 'fuzzy', 'all_of', 'any_of'], def: 'match' }),
      F('query', 'query 文本'), F('prefix', 'prefix 前缀'), F('pattern', 'pattern 通配'),
      F('analyzer', 'analyzer'), F('use_field', 'use_field'), F('max_gaps', 'max_gaps', 'number'),
      F('ordered', 'ordered 有序', 'checkbox'), BOOST,
    ],
    listKids: { key: 'intervals', label: '子词距规则（all_of / any_of 用）' },
    build(n) {
      const p = n.params;
      const mode = p.mode || 'match';
      const inner = {};
      for (const k of Object.keys(p)) {
        if (k === 'field' || k === 'mode' || isEmpty(p[k])) continue;
        inner[k] = coerce(p[k]);
      }
      const kids = (n.kids || []).map(gen).filter(Boolean);
      if (kids.length) inner.intervals = kids;
      const body = {};
      body[isEmpty(p.field) ? '?field?' : p.field] = { [mode]: inner };
      return { intervals: body };
    },
    fromJson(body, n) {
      const f = Object.keys(body || {})[0];
      if (!f) return;
      n.params.field = f;
      const modeObj = body[f] || {};
      const mode = Object.keys(modeObj)[0] || 'match';
      n.params.mode = mode;
      const inner = modeObj[mode] || {};
      for (const k of Object.keys(inner)) {
        if (k === 'intervals') continue;
        const v = inner[k];
        n.params[k] = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
      }
      n.kids = (inner.intervals || []).map(importNode).filter(Boolean);
    },
  });

  def({
    type: 'match_all', cat: 'fulltext', cn: '匹配全部',
    desc: '匹配所有文档，常配合 filter 或分页导出使用。',
    fields: [BOOST], leaf: true,
    build(n) { return { match_all: restParams(n, []) }; },
    fromJson(body, n) { genericFrom(body, n); },
  });
  def({
    type: 'match_none', cat: 'fulltext', cn: '匹配为空',
    desc: '不匹配任何文档。',
    fields: [BOOST], leaf: true,
    build(n) { return { match_none: restParams(n, []) }; },
    fromJson(body, n) { genericFrom(body, n); },
  });

  /* ===== 词项查询 ===== */
  function termQ(type, cn, valueKey, fields, desc) {
    def({
      type, cat: 'termq', cn, valueKey, desc,
      fields: [F('field', '字段名 *', 'text', { req: true }),
               F(valueKey, '值 *', 'text', { req: true })].concat(fields || []),
      build: fqBuild, fromJson: fqFrom,
      summary(n) { return (n.params.field || '?') + ' = ' + (n.params[valueKey] || ''); },
    });
  }
  termQ('term', '精确匹配', 'value', [BOOST, F('case_insensitive', '忽略大小写', 'checkbox')],
    '对不分词字段做精确匹配（keyword / 数值 / 布尔）。');
  termQ('prefix', '前缀匹配', 'value', [F('rewrite', 'rewrite'), F('case_insensitive', '忽略大小写', 'checkbox'), BOOST],
    '匹配以指定前缀开头的词项。');
  termQ('wildcard', '通配符匹配', 'value', [F('rewrite', 'rewrite'), F('case_insensitive', '忽略大小写', 'checkbox'), BOOST],
    '支持 ?（单字符）和 *（多字符），前导通配性能差。');
  termQ('regexp', '正则匹配', 'value', [
    F('flags', 'flags', 'text', { ph: 'ALL / COMPLEMENT|INTERVAL' }),
    F('case_insensitive', '忽略大小写', 'checkbox'),
    F('max_determinized_states', 'max_determinized_states', 'number', { ph: '10000' }),
    F('rewrite', 'rewrite'), BOOST,
  ], '正则表达式匹配词项。');
  termQ('fuzzy', '模糊匹配', 'value', [
    F('fuzziness', 'fuzziness', 'text', { ph: 'AUTO' }), F('max_expansions', 'max_expansions', 'number', { ph: '50' }),
    F('prefix_length', 'prefix_length', 'number', { ph: '0' }), F('transpositions', '允许换位', 'checkbox'),
    F('rewrite', 'rewrite'), BOOST,
  ], '基于编辑距离的模糊词项匹配。');

  def({
    type: 'terms', cat: 'termq', cn: '多值精确匹配', valueKey: 'values',
    desc: '字段值等于给定值列表中任意一个即命中（相当于多个 term OR）。',
    fields: [
      F('field', '字段名 *', 'text', { req: true }),
      F('values', '值列表 *（逗号或换行分隔）', 'textarea', { req: true, rows: 3, ph: '华为\n小米\n苹果' }), BOOST,
    ],
    build(n) {
      const f = isEmpty(n.params.field) ? '?field?' : n.params.field;
      const o = restParams(n, ['field', 'values']);
      o[f] = csv(n.params.values || '');
      return { terms: o };
    },
    fromJson(body, n) {
      for (const k of Object.keys(body || {})) {
        if (Array.isArray(body[k])) { n.params.field = k; n.params.values = body[k].join('\n'); }
        else n.params[k] = String(body[k]);
      }
    },
    summary(n) { return (n.params.field || '?') + ' in [' + String(n.params.values || '').split(/[\n,]+/).filter(Boolean).length + ' 项]'; },
  });

  def({
    type: 'terms_set', cat: 'termq', cn: '集合匹配', valueKey: 'terms',
    desc: '匹配至少包含指定数量词项的文档，最少匹配数可用字段或脚本控制。',
    fields: [
      F('field', '字段名 *', 'text', { req: true }),
      F('terms', '词项列表 *（逗号或换行）', 'textarea', { req: true, rows: 2 }),
      F('minimum_should_match_field', '最少匹配字段'), F('minimum_should_match_script', '最少匹配脚本', 'textarea', { rows: 2 }), BOOST,
    ],
    build(n) {
      const f = isEmpty(n.params.field) ? '?field?' : n.params.field;
      const inner = {};
      inner.terms = csv(n.params.terms || '');
      for (const k of ['minimum_should_match_field', 'minimum_should_match_script']) {
        if (!isEmpty(n.params[k])) inner[k] = n.params[k];
      }
      const o = { [f]: inner };
      if (!isEmpty(n.params.boost)) o.boost = coerce(n.params.boost);
      return { terms_set: o };
    },
    fromJson(body, n) {
      for (const k of Object.keys(body || {})) {
        if (k === 'boost') { n.params.boost = String(body[k]); continue; }
        n.params.field = k;
        const inner = body[k] || {};
        n.params.terms = (inner.terms || []).join('\n');
        if (inner.minimum_should_match_field) n.params.minimum_should_match_field = String(inner.minimum_should_match_field);
        if (inner.minimum_should_match_script) n.params.minimum_should_match_script = String(inner.minimum_should_match_script);
      }
    },
  });

  def({
    type: 'range', cat: 'termq', cn: '范围查询', valueKey: null,
    desc: '数值 / 日期范围，支持 gt gte lt lte、日期数学表达式（now-7d/d）。',
    fields: [
      F('field', '字段名 *', 'text', { req: true }),
      F('gt', 'gt 大于'), F('gte', 'gte 大于等于'), F('lt', 'lt 小于'), F('lte', 'lte 小于等于'),
      F('format', 'format 日期格式', 'text', { ph: 'yyyy-MM-dd' }),
      F('relation', 'relation', 'select', { opts: ['INTERSECTS', 'CONTAINS', 'WITHIN'] }),
      F('time_zone', 'time_zone', 'text', { ph: '+08:00' }), BOOST,
    ],
    build: fqBuild, fromJson: fqFrom,
    summary(n) {
      const p = n.params, seg = [];
      if (!isEmpty(p.gt)) seg.push('> ' + p.gt); if (!isEmpty(p.gte)) seg.push('>= ' + p.gte);
      if (!isEmpty(p.lt)) seg.push('< ' + p.lt); if (!isEmpty(p.lte)) seg.push('<= ' + p.lte);
      return (p.field || '?') + ' ' + (seg.join(' 且 ') || '(未设范围)');
    },
  });

  def({
    type: 'exists', cat: 'termq', cn: '字段存在', valueKey: null,
    desc: '字段有非空值即命中。',
    fields: [F('field', '字段名 *', 'text', { req: true }), BOOST],
    build(n) {
      const o = restParams(n, ['field']);
      o.field = n.params.field || '?field?';
      return { exists: o };
    },
    fromJson(body, n) { genericFrom(body, n); },
    summary(n) { return 'exists(' + (n.params.field || '?') + ')'; },
  });

  def({
    type: 'ids', cat: 'termq', cn: 'ID 查询', valueKey: 'values',
    desc: '按文档 _id 列表匹配。',
    fields: [F('values', '_id 列表 *（逗号或换行）', 'textarea', { req: true, rows: 2 }), BOOST],
    build(n) {
      const o = restParams(n, ['values']);
      o.values = csv(n.params.values || '');
      return { ids: o };
    },
    fromJson(body, n) { genericFrom(body, n); if (Array.isArray(body.values)) n.params.values = body.values.join('\n'); },
  });

  /* ===== 地理位置 ===== */
  def({
    type: 'geo_distance', cat: 'geo', cn: '地理距离', valueKey: null,
    desc: '匹配距中心点指定距离内的地理位置文档。',
    fields: [
      F('field', 'geo 字段名 *', 'text', { req: true, ph: 'location' }),
      F('location', '中心点 *', 'text', { req: true, ph: '31.23, 121.47 或 geohash' }),
      F('distance', '距离 *', 'text', { req: true, ph: '10km' }),
      F('distance_type', 'distance_type', 'select', { opts: ['arc', 'plane'] }),
      F('validation_method', 'validation_method', 'select', { opts: ['IGNORE_MALFORMED', 'COERCE', 'STRICT'] }), BOOST,
    ],
    build(n) {
      const o = restParams(n, ['field', 'location']);
      o[isEmpty(n.params.field) ? '?field?' : n.params.field] = n.params.location || '';
      return { geo_distance: o };
    },
    fromJson(body, n) {
      const known = ['distance', 'distance_type', 'validation_method', 'boost', 'ignore_unmapped'];
      for (const k of Object.keys(body || {})) {
        if (known.indexOf(k) !== -1) n.params[k] = String(body[k]);
        else { n.params.field = k; n.params.location = typeof body[k] === 'object' ? JSON.stringify(body[k]) : String(body[k]); }
      }
    },
    summary(n) { return (n.params.field || '?') + ' within ' + (n.params.distance || '?'); },
  });

  def({
    type: 'geo_bounding_box', cat: 'geo', cn: '地理矩形框', valueKey: null,
    desc: '匹配落在矩形框内的地理位置文档。',
    fields: [
      F('field', 'geo 字段名 *', 'text', { req: true }),
      F('top_left', '左上角 *', 'text', { req: true, ph: '31.5, 121.0' }),
      F('bottom_right', '右下角 *', 'text', { req: true, ph: '31.0, 121.8' }),
      F('type', 'type 索引方式', 'select', { opts: ['memory', 'indexed'] }),
      F('validation_method', 'validation_method', 'select', { opts: ['IGNORE_MALFORMED', 'COERCE', 'STRICT'] }), BOOST,
    ],
    build(n) {
      const inner = {};
      if (!isEmpty(n.params.top_left)) inner.top_left = n.params.top_left;
      if (!isEmpty(n.params.bottom_right)) inner.bottom_right = n.params.bottom_right;
      const o = restParams(n, ['field', 'top_left', 'bottom_right']);
      o[isEmpty(n.params.field) ? '?field?' : n.params.field] = inner;
      return { geo_bounding_box: o };
    },
    fromJson(body, n) {
      for (const k of Object.keys(body || {})) {
        const v = body[k];
        if (typeof v === 'object' && v !== null) {
          n.params.field = k;
          if (v.top_left !== undefined) n.params.top_left = typeof v.top_left === 'object' ? JSON.stringify(v.top_left) : String(v.top_left);
          if (v.bottom_right !== undefined) n.params.bottom_right = typeof v.bottom_right === 'object' ? JSON.stringify(v.bottom_right) : String(v.bottom_right);
        } else n.params[k] = String(v);
      }
    },
  });

  def({
    type: 'geo_polygon', cat: 'geo', cn: '地理多边形', valueKey: null,
    desc: '匹配落在多边形内的地理位置文档。',
    fields: [
      F('field', 'geo 字段名 *', 'text', { req: true }),
      F('points', '顶点列表 *（每行一个 lat,lon）', 'textarea', { req: true, rows: 4, ph: '31.5, 121.0\n31.5, 121.8\n31.0, 121.4' }),
      F('validation_method', 'validation_method', 'select', { opts: ['IGNORE_MALFORMED', 'COERCE', 'STRICT'] }), BOOST,
    ],
    build(n) {
      const o = restParams(n, ['field', 'points']);
      o[isEmpty(n.params.field) ? '?field?' : n.params.field] = { points: csv(n.params.points || '') };
      return { geo_polygon: o };
    },
    fromJson(body, n) {
      for (const k of Object.keys(body || {})) {
        const v = body[k];
        if (typeof v === 'object' && v !== null && v.points) { n.params.field = k; n.params.points = v.points.join('\n'); }
        else n.params[k] = String(v);
      }
    },
  });

  def({
    type: 'geo_shape', cat: 'geo', cn: '地理形状', valueKey: null,
    desc: '按 GeoJSON 形状做空间关系查询，也支持引用已索引的形状。',
    fields: [
      F('field', 'geo_shape 字段名 *', 'text', { req: true }),
      F('shape', 'GeoJSON 形状', 'json', { rows: 5, ph: '{"type":"polygon","coordinates":[[[121,31],[122,31],[122,32],[121,32],[121,31]]]}' }),
      F('relation', 'relation', 'select', { opts: ['INTERSECTS', 'DISJOINT', 'WITHIN', 'CONTAINS'] }),
      F('indexed_shape_id', '引用形状 id'), F('indexed_shape_index', '引用形状索引'),
      F('indexed_shape_path', '引用形状字段'), BOOST,
    ],
    build(n) {
      const inner = {};
      const shape = tryJSON(n.params.shape, undefined);
      if (shape) inner.shape = shape;
      if (!isEmpty(n.params.indexed_shape_id)) {
        inner.indexed_shape = {};
        if (!isEmpty(n.params.indexed_shape_id)) inner.indexed_shape.id = n.params.indexed_shape_id;
        if (!isEmpty(n.params.indexed_shape_index)) inner.indexed_shape.index = n.params.indexed_shape_index;
        if (!isEmpty(n.params.indexed_shape_path)) inner.indexed_shape.path = n.params.indexed_shape_path;
      }
      if (!isEmpty(n.params.relation)) inner.relation = n.params.relation;
      const o = {};
      if (!isEmpty(n.params.boost)) o.boost = coerce(n.params.boost);
      o[isEmpty(n.params.field) ? '?field?' : n.params.field] = inner;
      return { geo_shape: o };
    },
    fromJson(body, n) {
      for (const k of Object.keys(body || {})) {
        const v = body[k];
        if (k === 'boost') { n.params.boost = String(v); continue; }
        n.params.field = k;
        if (v.shape) n.params.shape = JSON.stringify(v.shape);
        if (v.relation) n.params.relation = String(v.relation);
        if (v.indexed_shape) {
          n.params.indexed_shape_id = v.indexed_shape.id || '';
          n.params.indexed_shape_index = v.indexed_shape.index || '';
          n.params.indexed_shape_path = v.indexed_shape.path || '';
        }
      }
    },
  });

  /* ===== 嵌套 / 父子 ===== */
  function joinQ(type, cn, extraFields, desc, extra) {
    def(Object.assign({
      type, cat: 'join', cn, desc,
      fields: extraFields.concat([BOOST]),
      slots: [{ key: 'query', label: 'query · 子查询', multi: false, color: '#64748b' }],
      build: slotsBuild(type),
      fromJson(body, n) {
        if (body.query) n.kids.query = [importNode(body.query)].filter(Boolean);
        genericFrom(body, n);
      },
    }, extra || {}));
  }
  joinQ('nested', '嵌套查询', [
    F('path', 'nested 路径 *', 'text', { req: true, ph: 'comments' }),
    F('score_mode', 'score_mode', 'select', { opts: ['avg', 'sum', 'min', 'max', 'none'] }),
    F('ignore_unmapped', 'ignore_unmapped', 'checkbox'),
  ], '查询 nested 嵌套对象数组，子查询作用在嵌套文档上。', {
    summary(n) { return 'nested(' + (n.params.path || '?') + ')'; },
  });
  joinQ('has_child', '有子文档', [
    F('type', '子类型 *', 'text', { req: true, ph: 'answer' }),
    F('score_mode', 'score_mode', 'select', { opts: ['avg', 'sum', 'min', 'max', 'none'] }),
    F('min_children', 'min_children', 'number'), F('max_children', 'max_children', 'number'),
    F('ignore_unmapped', 'ignore_unmapped', 'checkbox'),
  ], '父文档命中条件：存在匹配子查询的子文档（join 字段）。', {
    summary(n) { return 'has_child(' + (n.params.type || '?') + ')'; },
  });
  joinQ('has_parent', '有父文档', [
    F('parent_type', '父类型 *', 'text', { req: true, ph: 'question' }),
    F('score', 'score 参与评分', 'checkbox'), F('ignore_unmapped', 'ignore_unmapped', 'checkbox'),
  ], '子文档命中条件：父文档匹配子查询（join 字段）。', {
    summary(n) { return 'has_parent(' + (n.params.parent_type || '?') + ')'; },
  });

  def({
    type: 'parent_id', cat: 'join', cn: '按父 ID', valueKey: null,
    desc: '返回指定父文档 ID 下的子文档。',
    fields: [
      F('type', '子类型 *', 'text', { req: true }), F('id', '父文档 id *', 'text', { req: true }),
      F('ignore_unmapped', 'ignore_unmapped', 'checkbox'), BOOST,
    ],
    leaf: true,
    build(n) { return { parent_id: restParams(n, []) }; },
    fromJson(body, n) { genericFrom(body, n); },
    summary(n) { return 'parent ' + (n.params.type || '?') + '#' + (n.params.id || '?'); },
  });

  /* ===== 向量检索 ===== */
  def({
    type: 'knn', cat: 'vector', cn: 'kNN 向量', valueKey: null,
    desc: 'dense_vector 近似最近邻检索，可叠加 filter 预过滤。',
    fields: [
      F('field', '向量字段名 *', 'text', { req: true, ph: 'embedding' }),
      F('query_vector', '查询向量 *（逗号分隔浮点）', 'textarea', { req: true, rows: 3, ph: '0.12, -0.05, 0.88, ...' }),
      F('k', 'k 返回近邻数', 'number', { ph: '10' }),
      F('num_candidates', 'num_candidates 候选数', 'number', { ph: '100' }),
      F('similarity', 'similarity 最小相似度', 'number'), BOOST,
    ],
    slots: [{ key: 'filter', label: 'filter · 预过滤', multi: true, color: '#2563eb' }],
    build(n) {
      const o = restParams(n, ['query_vector']);
      if (!isEmpty(n.params.query_vector)) o.query_vector = csv(n.params.query_vector);
      const kids = (n.kids.filter || []).map(gen).filter(Boolean);
      if (kids.length === 1) o.filter = kids[0];
      else if (kids.length > 1) o.filter = kids;
      return { knn: o };
    },
    fromJson(body, n) {
      genericFrom(body, n);
      if (Array.isArray(body.query_vector)) n.params.query_vector = body.query_vector.join(', ');
      if (body.filter) {
        const list = Array.isArray(body.filter) ? body.filter : [body.filter];
        n.kids.filter = list.map(importNode).filter(Boolean);
      }
    },
    summary(n) { return 'knn(' + (n.params.field || '?') + ', k=' + (n.params.k || '?') + ')'; },
  });

  /* ===== Span 查询 ===== */
  function spanSlots(type, cn, slots, fields, desc) {
    def({
      type, cat: 'span', cn, desc,
      fields: fields || [],
      slots,
      build: slotsBuild(type),
      fromJson(body, n) {
        for (const s of slots) {
          if (body[s.key]) n.kids[s.key] = [importNode(body[s.key])].filter(Boolean);
        }
        genericFrom(body, n);
      },
    });
  }
  termQ('span_term', 'Span 词项', 'value', [BOOST], 'Span 家族的基础词项查询。');
  DEFS.span_term.cat = 'span';

  spanSlots('span_multi', 'Span 多词项包装', [
    { key: 'match', label: 'match · 多词项查询', multi: false, color: '#64748b' },
  ], [BOOST], '把 prefix / wildcard / fuzzy / regexp / term 等包装成 span 查询。');
  DEFS.span_multi.fromJson = function (body, n) {
    if (body.match) n.kids.match = [importNode(body.match)].filter(Boolean);
    genericFrom(body, n);
  };

  spanSlots('span_first', 'Span 前 N 位', [
    { key: 'match', label: 'match · 内部 span 查询', multi: false, color: '#64748b' },
  ], [F('end', 'end * 前几位的范围', 'number', { req: true, ph: '3' }), BOOST],
    '只匹配出现在字段前 end 个位置内的词项。');
  DEFS.span_first.fromJson = function (body, n) {
    if (body.match) n.kids.match = [importNode(body.match)].filter(Boolean);
    genericFrom(body, n);
  };

  def({
    type: 'span_near', cat: 'span', cn: 'Span 邻近',
    desc: '多个 span 子句彼此靠近（slop 距离内）才命中，可要求有序。',
    fields: [F('slop', 'slop * 允许间隔', 'number', { req: true, ph: '3' }), F('in_order', 'in_order 按顺序', 'checkbox'), BOOST],
    listKids: { key: 'clauses', label: 'clauses · span 子句列表' },
    build: listBuild('span_near', 'clauses'),
    fromJson(body, n) {
      n.kids = (body.clauses || []).map(importNode).filter(Boolean);
      genericFrom(body, n);
    },
  });

  def({
    type: 'span_or', cat: 'span', cn: 'Span 或',
    desc: '任一 span 子句命中即命中。',
    fields: [BOOST],
    listKids: { key: 'clauses', label: 'clauses · span 子句列表' },
    build: listBuild('span_or', 'clauses'),
    fromJson(body, n) {
      n.kids = (body.clauses || []).map(importNode).filter(Boolean);
      genericFrom(body, n);
    },
  });

  spanSlots('span_not', 'Span 排除', [
    { key: 'include', label: 'include · 包含', multi: false, color: '#0d9488' },
    { key: 'exclude', label: 'exclude · 排除', multi: false, color: '#dc2626' },
  ], [F('pre', 'pre 前置间隔', 'number'), F('post', 'post 后置间隔', 'number'), F('dist', 'dist 距离', 'number'), BOOST],
    '命中 include 但不与 exclude 重叠的区间。');

  spanSlots('span_containing', 'Span 包含', [
    { key: 'big', label: 'big · 大区间', multi: false, color: '#64748b' },
    { key: 'little', label: 'little · 小区间', multi: false, color: '#64748b' },
  ], [BOOST], '返回包含 little 命中的 big 区间。');

  spanSlots('span_within', 'Span 被包含', [
    { key: 'little', label: 'little · 小区间', multi: false, color: '#64748b' },
    { key: 'big', label: 'big · 大区间', multi: false, color: '#64748b' },
  ], [BOOST], '返回被 big 区间包含的 little 命中。');

  /* ===== 特殊查询 ===== */
  def({
    type: 'script', cat: 'special', cn: '脚本查询', valueKey: null,
    desc: '用 Painless 脚本自定义过滤逻辑，返回 true 即命中。',
    fields: [
      F('source', '脚本 source *', 'textarea', { req: true, rows: 3, ph: "doc['price'].value > params.min" }),
      F('lang', 'lang', 'select', { opts: ['painless', 'lucene', 'expression', 'mustache'] }),
      F('params', 'params (JSON)', 'json', { rows: 2, ph: '{"min": 100}' }), BOOST,
    ],
    leaf: true,
    build(n) {
      const s = {};
      if (!isEmpty(n.params.source)) s.source = n.params.source;
      if (!isEmpty(n.params.lang)) s.lang = n.params.lang;
      const p = tryJSON(n.params.params, undefined);
      if (p !== undefined) s.params = p;
      return { script: { script: s } };
    },
    fromJson(body, n) {
      const s = (body && body.script) || {};
      if (s.source) n.params.source = String(s.source);
      if (s.lang) n.params.lang = String(s.lang);
      if (s.params) n.params.params = JSON.stringify(s.params);
      if (body && body.boost !== undefined) n.params.boost = String(body.boost);
    },
    summary(n) { return String(n.params.source || '').slice(0, 40); },
  });

  def({
    type: 'script_score', cat: 'special', cn: '脚本评分',
    desc: '在子查询基础上用脚本重算得分。',
    fields: [
      F('source', '脚本 source *', 'textarea', { req: true, rows: 3, ph: "_score * doc['weight'].value" }),
      F('lang', 'lang', 'select', { opts: ['painless', 'lucene', 'expression', 'mustache'] }),
      F('params', 'params (JSON)', 'json', { rows: 2 }), F('min_score', 'min_score', 'number'), BOOST,
    ],
    slots: [{ key: 'query', label: 'query · 基础查询', multi: false, color: '#64748b' }],
    build(n) {
      const s = {};
      if (!isEmpty(n.params.source)) s.source = n.params.source;
      if (!isEmpty(n.params.lang)) s.lang = n.params.lang;
      const p = tryJSON(n.params.params, undefined);
      if (p !== undefined) s.params = p;
      const o = { script: s };
      const q = (n.kids.query || []).map(gen).filter(Boolean)[0];
      if (q) o.query = q;
      if (!isEmpty(n.params.min_score)) o.min_score = coerce(n.params.min_score);
      if (!isEmpty(n.params.boost)) o.boost = coerce(n.params.boost);
      return { script_score: o };
    },
    fromJson(body, n) {
      if (body.query) n.kids.query = [importNode(body.query)].filter(Boolean);
      const s = body.script || {};
      if (s.source) n.params.source = String(s.source);
      if (s.lang) n.params.lang = String(s.lang);
      if (s.params) n.params.params = JSON.stringify(s.params);
      if (body.min_score !== undefined) n.params.min_score = String(body.min_score);
    },
  });

  def({
    type: 'more_like_this', cat: 'special', cn: '相似文档 (MLT)', valueKey: 'like',
    desc: '根据给定文本/文档找内容相似的文档。',
    fields: [
      F('fields', '分析字段 *（逗号分隔）', 'text', { req: true, ph: 'title, content' }),
      F('like', 'like 文本或 JSON 数组 *', 'textarea', { req: true, rows: 3 }),
      F('unlike', 'unlike 排除文本', 'textarea', { rows: 2 }),
      F('min_term_freq', 'min_term_freq', 'number', { ph: '2' }),
      F('max_query_terms', 'max_query_terms', 'number', { ph: '25' }),
      F('min_doc_freq', 'min_doc_freq', 'number', { ph: '5' }),
      F('max_doc_freq', 'max_doc_freq', 'number'),
      F('min_word_length', 'min_word_length', 'number'), F('max_word_length', 'max_word_length', 'number'),
      F('minimum_should_match', 'minimum_should_match', 'text', { ph: '30%' }),
      F('analyzer', 'analyzer'), BOOST,
    ],
    leaf: true,
    build(n) {
      const o = restParams(n, ['fields', 'like', 'unlike']);
      if (!isEmpty(n.params.fields)) o.fields = csv(n.params.fields);
      const like = tryJSON(n.params.like, undefined);
      o.like = like !== undefined ? like : (n.params.like || '');
      const unlike = tryJSON(n.params.unlike, undefined);
      if (!isEmpty(n.params.unlike)) o.unlike = unlike !== undefined ? unlike : n.params.unlike;
      return { more_like_this: o };
    },
    fromJson(body, n) {
      genericFrom(body, n);
      if (Array.isArray(body.fields)) n.params.fields = body.fields.join(', ');
      if (body.like !== undefined) n.params.like = typeof body.like === 'object' ? JSON.stringify(body.like) : String(body.like);
      if (body.unlike !== undefined) n.params.unlike = typeof body.unlike === 'object' ? JSON.stringify(body.unlike) : String(body.unlike);
    },
  });

  def({
    type: 'percolate', cat: 'special', cn: '反向匹配', valueKey: null,
    desc: 'percolator 反向查询：给定文档，找出所有"会命中它"的已注册查询。',
    fields: [
      F('field', 'percolator 字段名 *', 'text', { req: true, ph: 'query' }),
      F('document', '单文档 (JSON)', 'json', { rows: 4, ph: '{"title": "新款手机发布"}' }),
      F('documents', '多文档 (JSON 数组)', 'json', { rows: 3 }),
      F('id', '已索引文档 id'), F('index', '已索引文档所在索引'), BOOST,
    ],
    leaf: true,
    build(n) {
      const o = restParams(n, ['document', 'documents']);
      const doc = tryJSON(n.params.document, undefined);
      if (doc !== undefined) o.document = doc;
      const docs = tryJSON(n.params.documents, undefined);
      if (docs !== undefined) o.documents = docs;
      return { percolate: o };
    },
    fromJson(body, n) {
      genericFrom(body, n);
      if (body.document) n.params.document = JSON.stringify(body.document);
      if (body.documents) n.params.documents = JSON.stringify(body.documents);
    },
  });

  def({
    type: 'rank_feature', cat: 'special', cn: '排序特征', valueKey: null,
    desc: '按 rank_feature / rank_features 字段加速数值排序打分。',
    fields: [
      F('field', '字段名 *', 'text', { req: true }),
      F('function', '打分函数', 'select', { opts: ['linear', 'saturation', 'log', 'sigmoid'], def: 'linear' }),
      F('pivot', 'pivot（saturation/sigmoid）', 'number'),
      F('scaling_factor', 'scaling_factor（log）', 'number'),
      F('exponent', 'exponent（sigmoid）', 'number'), BOOST,
    ],
    leaf: true,
    build(n) {
      const p = n.params;
      const o = {};
      const fn = p.function || 'linear';
      if (fn === 'saturation') { o.saturation = {}; if (!isEmpty(p.pivot)) o.saturation.pivot = coerce(p.pivot); }
      else if (fn === 'log') { o.log = {}; if (!isEmpty(p.scaling_factor)) o.log.scaling_factor = coerce(p.scaling_factor); }
      else if (fn === 'sigmoid') {
        o.sigmoid = {};
        if (!isEmpty(p.pivot)) o.sigmoid.pivot = coerce(p.pivot);
        if (!isEmpty(p.exponent)) o.sigmoid.exponent = coerce(p.exponent);
      } else o.linear = {};
      o.field = p.field || '?field?';
      if (!isEmpty(p.boost)) o.boost = coerce(p.boost);
      return { rank_feature: o };
    },
    fromJson(body, n) {
      if (body.field) n.params.field = String(body.field);
      if (body.saturation) { n.params.function = 'saturation'; n.params.pivot = String(body.saturation.pivot || ''); }
      else if (body.log) { n.params.function = 'log'; n.params.scaling_factor = String(body.log.scaling_factor || ''); }
      else if (body.sigmoid) { n.params.function = 'sigmoid'; n.params.pivot = String(body.sigmoid.pivot || ''); n.params.exponent = String(body.sigmoid.exponent || ''); }
      if (body.boost !== undefined) n.params.boost = String(body.boost);
    },
    summary(n) { return 'rank(' + (n.params.field || '?') + ')'; },
  });

  def({
    type: 'distance_feature', cat: 'special', cn: '距离特征', valueKey: null,
    desc: '按文档与原点（时间/地理位置）的距离加分，越近分越高。',
    fields: [
      F('field', '字段名 *（date 或 geo_point）', 'text', { req: true }),
      F('origin', 'origin 原点 *', 'text', { req: true, ph: 'now 或 31.23,121.47' }),
      F('pivot', 'pivot 衰减距离 *', 'text', { req: true, ph: '7d 或 10km' }), BOOST,
    ],
    leaf: true,
    build(n) { return { distance_feature: restParams(n, []) }; },
    fromJson(body, n) { genericFrom(body, n); },
    summary(n) { return (n.params.field || '?') + ' ~ ' + (n.params.origin || '?'); },
  });

  def({
    type: 'pinned', cat: 'special', cn: '置顶查询', valueKey: null,
    desc: '把指定 _id 的文档固定在结果最前面，其余按 organic 查询排序。',
    fields: [F('ids', '置顶文档 _id（逗号分隔）', 'text', { ph: '1, 4, 100' })],
    slots: [{ key: 'organic', label: 'organic · 自然排序查询', multi: false, color: '#64748b' }],
    build(n) {
      const o = {};
      if (!isEmpty(n.params.ids)) o.ids = csv(n.params.ids);
      const q = (n.kids.organic || []).map(gen).filter(Boolean)[0];
      if (q) o.organic = q;
      return { pinned: o };
    },
    fromJson(body, n) {
      if (Array.isArray(body.ids)) n.params.ids = body.ids.join(', ');
      if (body.organic) n.kids.organic = [importNode(body.organic)].filter(Boolean);
    },
  });

  /* ===== 评分函数（function_score 子节点） ===== */
  function fnFilterSlot() {
    return [{ key: 'filter', label: 'filter · 作用范围（可选）', multi: false, color: '#2563eb' }];
  }

  def({
    type: 'fn_weight', cat: 'fn', cn: '权重函数',
    desc: '命中 filter 的文档得分乘以固定 weight。',
    fields: [F('weight', 'weight 权重 *', 'number', { req: true, ph: '2' })],
    slots: fnFilterSlot(),
    build(n) {
      const o = { weight: coerce(n.params.weight || '1') };
      const f = (n.kids.filter || []).map(gen).filter(Boolean)[0];
      if (f) o.filter = f;
      return o;
    },
    fromJson(body, n) {
      n.params.weight = String(body.weight || '');
      if (body.filter) n.kids.filter = [importNode(body.filter)].filter(Boolean);
    },
    summary(n) { return 'weight × ' + (n.params.weight || '?'); },
  });

  def({
    type: 'fn_random_score', cat: 'fn', cn: '随机评分',
    desc: '产生随机分数，可指定 seed 与 field 保证同用户结果稳定。',
    fields: [F('seed', 'seed 随机种子'), F('field', 'field 排序字段')],
    slots: fnFilterSlot(),
    build(n) {
      const inner = {};
      if (!isEmpty(n.params.seed)) inner.seed = coerce(n.params.seed);
      if (!isEmpty(n.params.field)) inner.field = n.params.field;
      const o = { random_score: inner };
      const f = (n.kids.filter || []).map(gen).filter(Boolean)[0];
      if (f) o.filter = f;
      return o;
    },
    fromJson(body, n) {
      const r = body.random_score || {};
      if (r.seed !== undefined) n.params.seed = String(r.seed);
      if (r.field) n.params.field = String(r.field);
      if (body.filter) n.kids.filter = [importNode(body.filter)].filter(Boolean);
    },
  });

  def({
    type: 'fn_script_score', cat: 'fn', cn: '脚本评分函数',
    desc: '用脚本为每个文档计算函数分。',
    fields: [
      F('source', '脚本 source *', 'textarea', { req: true, rows: 2, ph: "Math.log(2 + doc['likes'].value)" }),
      F('params', 'params (JSON)', 'json', { rows: 2 }),
    ],
    slots: fnFilterSlot(),
    build(n) {
      const s = {};
      if (!isEmpty(n.params.source)) s.source = n.params.source;
      const p = tryJSON(n.params.params, undefined);
      if (p !== undefined) s.params = p;
      const o = { script_score: { script: s } };
      const f = (n.kids.filter || []).map(gen).filter(Boolean)[0];
      if (f) o.filter = f;
      return o;
    },
    fromJson(body, n) {
      const s = (body.script_score && body.script_score.script) || {};
      if (s.source) n.params.source = String(s.source);
      if (s.params) n.params.params = JSON.stringify(s.params);
      if (body.filter) n.kids.filter = [importNode(body.filter)].filter(Boolean);
    },
  });

  def({
    type: 'fn_field_value_factor', cat: 'fn', cn: '字段值因子',
    desc: '把数值字段经修饰函数（log/sqrt 等）后作为得分因子。',
    fields: [
      F('field', '数值字段名 *', 'text', { req: true, ph: 'views' }),
      F('factor', 'factor 系数', 'number', { ph: '1.2' }),
      F('modifier', 'modifier 修饰', 'select', { opts: ['none', 'log', 'log1p', 'log2p', 'ln', 'ln1p', 'ln2p', 'square', 'sqrt', 'reciprocal'] }),
      F('missing', 'missing 缺省值', 'number', { ph: '1' }),
    ],
    slots: fnFilterSlot(),
    build(n) {
      const inner = {};
      if (!isEmpty(n.params.field)) inner.field = n.params.field;
      if (!isEmpty(n.params.factor)) inner.factor = coerce(n.params.factor);
      if (!isEmpty(n.params.modifier)) inner.modifier = n.params.modifier;
      if (!isEmpty(n.params.missing)) inner.missing = coerce(n.params.missing);
      const o = { field_value_factor: inner };
      const f = (n.kids.filter || []).map(gen).filter(Boolean)[0];
      if (f) o.filter = f;
      return o;
    },
    fromJson(body, n) {
      const r = body.field_value_factor || {};
      for (const k of ['field', 'factor', 'modifier', 'missing']) if (r[k] !== undefined) n.params[k] = String(r[k]);
      if (body.filter) n.kids.filter = [importNode(body.filter)].filter(Boolean);
    },
    summary(n) { return 'fvf(' + (n.params.field || '?') + ')'; },
  });

  def({
    type: 'fn_decay', cat: 'fn', cn: '衰减函数',
    desc: '高斯/线性/指数衰减：离 origin 越远分越低，常用于时间与地理位置加权。',
    fields: [
      F('kind', '衰减类型', 'select', { opts: ['gauss', 'linear', 'exp'], def: 'gauss' }),
      F('field', '字段名 *', 'text', { req: true, ph: 'publish_date' }),
      F('origin', 'origin 原点 *', 'text', { req: true, ph: 'now' }),
      F('scale', 'scale 衰减尺度 *', 'text', { req: true, ph: '7d' }),
      F('offset', 'offset 偏移', 'text', { ph: '0d' }),
      F('decay', 'decay 衰减到', 'number', { ph: '0.5' }),
      F('multi_value_mode', 'multi_value_mode', 'select', { opts: ['min', 'max', 'avg', 'sum'] }),
    ],
    slots: fnFilterSlot(),
    build(n) {
      const p = n.params;
      const kind = p.kind || 'gauss';
      const inner = {};
      if (!isEmpty(p.origin)) inner.origin = p.origin;
      if (!isEmpty(p.scale)) inner.scale = p.scale;
      if (!isEmpty(p.offset)) inner.offset = p.offset;
      if (!isEmpty(p.decay)) inner.decay = coerce(p.decay);
      const o = { [kind]: { [isEmpty(p.field) ? '?field?' : p.field]: inner } };
      if (!isEmpty(p.multi_value_mode)) o.multi_value_mode = p.multi_value_mode;
      const f = (n.kids.filter || []).map(gen).filter(Boolean)[0];
      if (f) o.filter = f;
      return o;
    },
    fromJson(body, n) {
      for (const kind of ['gauss', 'linear', 'exp']) {
        if (body[kind]) {
          n.params.kind = kind;
          const f = Object.keys(body[kind])[0];
          n.params.field = f;
          const inner = body[kind][f] || {};
          for (const k of ['origin', 'scale', 'offset', 'decay']) if (inner[k] !== undefined) n.params[k] = String(inner[k]);
        }
      }
      if (body.multi_value_mode) n.params.multi_value_mode = String(body.multi_value_mode);
      if (body.filter) n.kids.filter = [importNode(body.filter)].filter(Boolean);
    },
    summary(n) { return (n.params.kind || 'gauss') + '(' + (n.params.field || '?') + ')'; },
  });

  /* ===== 自定义 ===== */
  def({
    type: 'raw', cat: 'custom', cn: '自定义 JSON',
    desc: '直接编写任意 DSL 片段（如 agg、runtime mappings、暂未内置的查询），原样输出。',
    fields: [F('json', 'JSON 片段 *', 'json', { req: true, rows: 8, ph: '{"match": {"title": "hello"}}' })],
    leaf: true,
    build(n) {
      const v = tryJSON(n.params.json, undefined);
      return v === undefined ? {} : v;
    },
    fromJson() {},
    summary(n) { return String(n.params.json || '').replace(/\s+/g, ' ').slice(0, 40); },
  });

  /* ---------------- 节点工厂 ---------------- */
  function mkNode(type) {
    const d = DEFS[type];
    if (!d) throw new Error('未知查询类型: ' + type);
    const n = { id: uid(), type, params: {}, collapsed: false };
    for (const f of d.fields) {
      if (f.def !== undefined) n.params[f.k] = f.def;
      else if (f.kind === 'checkbox') n.params[f.k] = '';
      else n.params[f.k] = '';
    }
    if (d.slots) {
      n.kids = {};
      for (const s of d.slots) n.kids[s.key] = [];
    } else if (d.listKids) {
      n.kids = [];
    }
    return n;
  }

  function rawNodeFrom(obj) {
    const n = mkNode('raw');
    n.params.json = JSON.stringify(obj, null, 2);
    return n;
  }

  /* ---------------- 生成 / 导入 ---------------- */
  function gen(node) {
    if (!node) return null;
    const d = DEFS[node.type];
    if (!d || !d.build) return null;
    try { return d.build(node); } catch (e) { return null; }
  }

  function importNode(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const keys = Object.keys(obj);
    if (keys.length !== 1) return rawNodeFrom(obj);
    const type = keys[0];
    const body = obj[type];
    const d = DEFS[type];
    // fn_* 导入别名：function_score 的 functions 元素没有包裹类型名
    if (!d || typeof body !== 'object' || body === null) {
      const fnType = detectFn(obj);
      if (fnType) return fnType;
      return rawNodeFrom(obj);
    }
    if (!d.fromJson) return rawNodeFrom(obj);
    const n = mkNode(type);
    try {
      d.fromJson(body, n);
      return n;
    } catch (e) {
      return rawNodeFrom(obj);
    }
  }

  // function_score 的 functions 数组元素：{weight:..}/{random_score:{}}/{script_score:..}/{field_value_factor:..}/{gauss:..}
  function detectFn(obj) {
    let n = null;
    if (obj.weight !== undefined) { n = mkNode('fn_weight'); DEFS.fn_weight.fromJson(obj, n); }
    else if (obj.random_score !== undefined) { n = mkNode('fn_random_score'); DEFS.fn_random_score.fromJson(obj, n); }
    else if (obj.script_score !== undefined && obj.script_score.script) { n = mkNode('fn_script_score'); DEFS.fn_script_score.fromJson(obj, n); }
    else if (obj.field_value_factor !== undefined) { n = mkNode('fn_field_value_factor'); DEFS.fn_field_value_factor.fromJson(obj, n); }
    else if (obj.gauss || obj.linear || obj.exp) { n = mkNode('fn_decay'); DEFS.fn_decay.fromJson(obj, n); }
    return n;
  }

  /* ---------------- 校验 ---------------- */
  function validate(root) {
    const issues = [];
    function walk(node, path) {
      const d = DEFS[node.type];
      if (!d) return;
      const label = path + ' / ' + node.type;
      for (const f of d.fields) {
        if (f.req && isEmpty(node.params[f.k])) {
          issues.push(label + '：缺少必填项「' + f.label.replace(/ \*$/, '') + '」');
        }
        if (f.kind === 'json' && !isEmpty(node.params[f.k])) {
          try { JSON.parse(node.params[f.k]); }
          catch (e) { issues.push(label + '：「' + f.label + '」不是合法 JSON'); }
        }
      }
      if (d.slots) {
        for (const s of d.slots) {
          for (const c of (node.kids[s.key] || [])) walk(c, label);
        }
      } else if (d.listKids) {
        for (const c of (node.kids || [])) walk(c, label);
      }
      if (node.type === 'bool') {
        const total = ['must', 'should', 'must_not', 'filter'].reduce((a, s) => a + (node.kids[s] || []).length, 0);
        if (total === 0) issues.push(label + '：bool 四个子句都为空');
      }
    }
    if (root) walk(root, 'query');
    return issues;
  }

  /* ---------------- 导出 ---------------- */
  const api = {
    CATS, CATMAP, DEFS, mkNode, gen, importNode, validate,
    uid, isEmpty, coerce, csv, tryJSON,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ESQ = api;
})(typeof window !== 'undefined' ? window : globalThis);
