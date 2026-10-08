# ES DSL Studio

> Elasticsearch 可视化查询编辑器 —— 不用背 DSL，拖出来就是查询 JSON。

ES 的查询 DSL 本质上是一棵树：组合查询是内部节点，词项/全文查询是叶子节点。ES DSL Studio 把这棵树直接画出来——从左侧元素库拖拽查询节点到画布、嵌套组合，右侧实时生成语法高亮的 DSL JSON，所见即所得。

纯 HTML / CSS / 原生 JS 实现，**零依赖、零构建**，双击 `index.html` 即可使用。

![主界面](docs/screenshot-main.png)

## 功能特性

### 拖拽式查询树编辑

- 左侧元素库收录 **56 种查询类型**，按 10 个分类着色分组，支持关键词搜索
- 拖拽或点 `+` 添加节点；组合查询（bool 等）带彩色槽位，拖入即建立嵌套关系
- 已有节点可拖动调整层级与顺序、复制、删除、一键「包一层 bool」
- 往已有根查询上再拖一个查询，自动用 bool 组合
- 点选节点后，在树下方属性面板中表单化编辑参数（带必填校验）

### 实时 DSL 生成

- 右侧 JSON 面板实时输出完整 search body，语法高亮
- 支持 size / from / track_total_hits / min_score 查询设置
- 一键复制到剪贴板、下载 `.json` 文件
- 底部状态栏实时提示必填缺失与 JSON 格式错误

### DSL 反向导入

![导入 JSON](docs/screenshot-import.png)

粘贴已有的 DSL（完整 search body 或 query 片段），自动解析回查询树继续编辑。
遇到编辑器尚未内置的新语法，自动降级为「自定义 JSON」节点原样保留，**不丢任何数据**。

### 节点属性编辑

![属性编辑](docs/screenshot-edit.png)

### 其他

- 槽位颜色语义化：`must` 青 / `should` 橙 / `must_not` 红 / `filter` 蓝
- 查询树自动保存到 localStorage，刷新不丢
- 评分函数（weight / random / script / field_value_factor / decay）只能放入 function_score 的 functions 槽位，防止误用
- `Delete` 删除选中节点，`Esc` 取消选中

## 支持的查询类型（ES 7.x / 8.x）

| 分类 | 查询 |
|------|------|
| 组合查询 | bool、dis_max、constant_score、function_score、boosting |
| 全文检索 | match、match_phrase、match_phrase_prefix、match_bool_prefix、multi_match、combined_fields、query_string、simple_query_string、intervals、match_all、match_none |
| 词项查询 | term、terms、terms_set、range、exists、prefix、wildcard、regexp、fuzzy、ids |
| 地理位置 | geo_distance、geo_bounding_box、geo_polygon、geo_shape |
| 嵌套/父子 | nested、has_child、has_parent、parent_id |
| 向量检索 | knn（支持 filter 预过滤） |
| Span 查询 | span_term、span_multi、span_first、span_near、span_or、span_not、span_containing、span_within |
| 特殊查询 | script、script_score、more_like_this、percolate、rank_feature、distance_feature、pinned |
| 评分函数 | weight、random_score、script_score、field_value_factor、decay（gauss / linear / exp） |
| 自定义 | raw JSON（任意 DSL 片段原样嵌入） |

## 快速开始

```bash
# 无需安装任何东西，直接用浏览器打开
start index.html        # Windows
open index.html         # macOS
```

或者起一个本地服务（可选）：

```bash
python -m http.server 8080
# 访问 http://localhost:8080
```

## 项目结构

```
es-dsl-editor/
├── index.html          # 页面骨架
├── css/
│   └── styles.css      # 全部样式（浅色主题）
├── js/
│   ├── queries.js      # 核心：56 种查询类型定义 + 树↔DSL 双向转换 + 校验（纯逻辑，无 DOM）
│   └── app.js          # UI：元素库 / 拖拽 / 查询树 / 属性面板 / JSON 预览与导入导出
├── test/
│   └── core.test.js    # 核心逻辑回归测试（24 项：生成 + 导入往返 + 校验）
├── docs/               # README 截图
└── README.md
```

## 开发与测试

核心逻辑与 UI 完全分离，`js/queries.js` 可在 Node 中直接加载测试：

```bash
node test/core.test.js
```

### 新增一种查询类型

只需在 `js/queries.js` 中追加一个定义（字段表单、DSL 生成、JSON 反向解析），UI 会自动出现在元素库中：

```js
def({
  type: 'my_query', cat: 'termq', cn: '我的查询', valueKey: 'value',
  desc: '一句话说明。',
  fields: [
    { k: 'field', label: '字段名 *', kind: 'text', req: true },
    { k: 'value', label: '值 *', kind: 'text', req: true },
  ],
  build: fqBuild,        // 标准 {type: {field: {...}}} 结构可直接复用
  fromJson: fqFrom,
});
```

## 浏览器兼容

Chrome / Edge / Firefox 最新版本（依赖 `color-mix()`、ES2020+）。

## License

MIT
