# 免费开放检索网关

## 目的与边界

本项目内置一个轻量 Node.js 检索网关，供受访问码保护的网站接口、赛前同步任务和 LLM 风险审查共用。它不依赖付费搜索 API，也不把 Codex、ChatGPT、Gemini 或浏览器登录态转换成代理服务。

网关只做三件事：

1. 从公开搜索/元数据服务发现资料；
2. 对 DOI 使用 Unpaywall 定位已被确认的合法开放版本；
3. 将结果压缩成可审计的哈希、计数、时间和来源状态，再交给 AI。

它不会抓取付费正文，不会绕过登录、验证码或付费墙，也不会把收费页面的搜索摘要冒充全文。找不到合法开放版本时，返回 `restricted` 或 `metadata_only`。

## 当前架构

```text
访问码用户 / 同步任务
        |
        v
Open Research Gateway
  |-- Wikipedia zh/en (开放条目)
  |-- GDELT DOC API (新闻发现元数据)
  |-- Crossref (DOI 与出版元数据)
  |-- Unpaywall (可选，合法 OA 地址)
  `-- SearXNG (可选，HTTPS 或本机回环)
        |
        +--> 受保护搜索 API：展示来源元数据
        +--> webConsensus：审计/提示层，模型权重固定为 0
        `--> LLM evidence：仅哈希、计数、时间和状态
```

默认实现不在轻量生产服务器上运行浏览器、容器、SearXNG 或本地大模型。若以后有独立资源，可配置外部 SearXNG；当前免费基线直接使用公开接口。

## 网站接口

先使用现有访问码换取 6 小时会话：

```http
POST /api/access/verify
Content-Type: application/json

{"code":"XXXX-XXXX-XXXX"}
```

查看网关状态：

```http
GET /api/v1/research/status
X-Access-Token: <session token>
```

执行关键词检索：

```http
POST /api/v1/research/search
X-Access-Token: <session token>
Content-Type: application/json

{
  "query": "Arsenal Chelsea injury news",
  "limit": 8
}
```

定位 DOI 的合法开放版本：

```http
POST /api/v1/research/search
X-Access-Token: <session token>
Content-Type: application/json

{
  "doi": "10.1234/example",
  "providers": ["crossref", "unpaywall"],
  "limit": 4
}
```

请求只能包含 `query`、裸 DOI、结果上限和固定 provider 名单；不能提交待抓取 URL。默认每个访问会话允许 3 次突发请求，此后约每 5 秒补充一次；全站最多同时执行 2 个检索请求。每个上游都有强制超时，单个上游故障会作为 `partial` 返回，不拖垮比赛主数据链。

结果中的 `open` 表示上游确认有开放访问位置；`metadata_only` 只表示可以展示标题、DOI、来源等发现信息；`restricted` 表示没有合法开放版本。无论哪一种，网关都不下载或转发收费正文。

## 自动接入预测系统

同步 worker 的慢速增强阶段按以下顺序执行：

```text
sync:open-research
  -> sync:web-consensus
  -> sync:prematch
  -> validate/data generation/SQLite
```

`sync:open-research` 只挑选有限数量的未开赛比赛。原始发现元数据留在服务端审计文件；写入比赛对象的 `externalSignals.openResearch` 只包含：

- 检索时间和请求/结果集哈希；
- provider 成功、失败和耗时计数；
- `open`、`metadata_only`、`restricted` 数量；
- 每个结果的内容地址哈希。

该结构不会包含 query、标题、URL、snippet 或网页正文。`webConsensus` 仍是 advisory/audit 层，不能改变正式推荐方向、概率或模型特征。LLM 只能看到同一份结构化覆盖审计，用来指出“证据不足/来源失败”等风险，不能利用外部文本覆写算法。

worker 在一轮慢增强完成后重新建立 relay 指纹基线，只让“完成之后”的新快照提前唤醒下一轮；本轮执行期间已发生的变化不会造成零等待自旋。生产环境至少保留 10 秒空闲窗口，既降低连续重算负载，也让签名发布能冻结在完整周期之后的安全状态。

## 环境变量

```dotenv
ENABLE_OPEN_RESEARCH_SYNC=1
ENABLE_WEB_CONSENSUS_SYNC=1
WEB_CONSENSUS_REFRESH_MINUTES=30
OPEN_RESEARCH_MAX_MATCHES=4
OPEN_RESEARCH_MAX_RESULTS=8
OPEN_RESEARCH_TIMEOUT_MS=7000
OPEN_RESEARCH_CACHE_TTL_MINUTES=30
OPEN_RESEARCH_REFRESH_MINUTES=30
OPEN_RESEARCH_MAX_CONCURRENCY=2
OPEN_RESEARCH_RATE_BURST=3
OPEN_RESEARCH_RATE_REFILL_MS=5000

# 可选
OPEN_RESEARCH_CONTACT_EMAIL=
OPEN_RESEARCH_CONTACT_URL=https://your-domain.example/
OPEN_RESEARCH_UNPAYWALL_EMAIL=
OPEN_RESEARCH_SEARXNG_BASE_URL=
```

`OPEN_RESEARCH_CONTACT_URL` 用于 Wikimedia 要求的客户端身份标识，生产发布会自动写入站点公网 HTTPS 地址。Unpaywall 要求有效联系邮箱；不填写时 provider 自动禁用，Crossref、Wikipedia 和 GDELT 仍可工作。SearXNG 只接受 HTTPS 地址，或部署机回环地址上的 HTTP，且不能指向私网/链路本地字面地址。

## 免费来源与使用约束

- [MediaWiki Search API](https://www.mediawiki.org/wiki/API:Search_and_discovery)：公开百科发现；内容复用仍需遵守 Wikimedia 许可与署名要求。
- [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)：新闻发现索引；原媒体内容权利不随索引结果转移。生产网络下可能超时，因此仅在请求的 `providers` 中显式指定 `gdelt` 时启用，不阻塞默认查询与缓存。
- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)：无需付费 key 的 DOI/出版元数据接口，应遵守其限流并建议提供联系邮箱。
- [Unpaywall API](https://unpaywall.org/products/api)：免费 DOI 开放版本定位，需要联系邮箱；只有其确认的 HTTPS OA 位置才标为 `open`。
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)：可选自托管通用检索入口；它依赖上游引擎，不能保证稳定性或规避上游限制。

这里的“完全免费”是指软件许可证和第三方 API 调用费可以为零。现有服务器、电力、带宽和运维本身仍有成本。

## 验证

```powershell
npm.cmd run verify:open-research-gateway
npm.cmd run verify:llm-evidence-boundary
node scripts/verifySyncWorkerCadence.cjs
npm.cmd run verify:api-contracts
```

网关测试使用本地 mock，覆盖 URL/SSRF 拒绝、超时、部分失败、去重、缓存 TTL、付费内容不泄漏、合法 OA 地址和 AI 安全摘要。
