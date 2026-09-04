# 使用 ChatGPT Pro 手动审计足球预测数据

本方案把网站数据导出成一个可检查、可重复生成的离线分析包，再由你手动上传到 ChatGPT Pro。导出器不会登录 ChatGPT、不会读取浏览器 Cookie 或聊天历史，也不会调用 OpenAI API。

## 产品边界

- ChatGPT Pro 可以在对话或 Project 中手动上传 CSV 并进行表格分析、统计和可视化。OpenAI 的[数据分析说明](https://help.openai.com/en/articles/9213685)和[文件上传 FAQ](https://help.openai.com/en/articles/8555545-chatgpt-citations)描述了这一用法。
- Pro 订阅不能作为网站后端 API 配额。OpenAI 明确说明 [API 与 ChatGPT 分开管理和计费](https://help.openai.com/en/articles/8156019-i-want-to-move-my-chatgpt-subscription-to-the-api)。
- 不要用脚本驱动 ChatGPT 网页、复用登录态、Cookie 或浏览器会话来实现自动分析。后续若要让网站自动运行，需单独开通 OpenAI API 项目与计费，把 API Key 只保存在服务器端，并另行实现固定输入/输出、审计日志和权限边界。

## 生成分析包

默认从 `public/data` 读取 JSON：

```powershell
node scripts/exportChatGptAnalysisPack.cjs --out .local/chatgpt-analysis-pack
```

也可以读取由现有仓库导出的 SQLite 仓库（需要支持 `node:sqlite` 的 Node.js）：

```powershell
node scripts/exportChatGptAnalysisPack.cjs --sqlite server-data/football.db --out .local/chatgpt-analysis-pack
```

指定另一份 JSON 数据目录：

```powershell
node scripts/exportChatGptAnalysisPack.cjs --data-dir D:\safe-football-export --out D:\analysis-pack
```

查看参数或运行内置自测：

```powershell
node scripts/exportChatGptAnalysisPack.cjs --help
node scripts/exportChatGptAnalysisPack.cjs --self-test
```

脚本只覆盖输出目录内由它管理的文件。数据会先稳定排序和去重；相同输入重复运行不会追加重复行。每个 CSV 默认不超过 45 MiB；超限时第一片保留原文件名，后续生成 `.part-0002.csv`、`.part-0003.csv` 等确定性分片。旧的多余分片会在下次运行时清理。

## 包内文件

| 文件 | 阶段 | 用途 |
| --- | --- | --- |
| `matches.csv` | 赛前 | 比赛标识、球队、联赛、开赛与 cutoff；不含比分和赛果 |
| `odds_snapshots*.csv` | 赛前 | 仅保留系统在 cutoff 前观察到的 HAD/HHAD 赔率和去水概率 |
| `predictions*.csv` | 赛前 | 仅保留 cutoff 前冻结或记录的预测；不含命中状态 |
| `settlements*.csv` | 赛后 | 用 `prediction_id` 连接的最终比分、实际结果和重新计算的结算 |
| `manifest.json` | 元数据 | 数据集、分片、行数、字节、SHA-256、时间边界、排除原因和隐私边界 |
| `data_dictionary.md` | 元数据 | 字段解释、连接键、HAD/HHAD 规则和时间边界 |
| `prompt.md` | 指令 | 建议直接用于 ChatGPT Pro 的历史审计提示词 |

这里的物理分区很重要：先用三个赛前文件检查时间完整性，最后才连接 `settlements`。让球数缺失时导出器不会默认成 `0`，而会把该结算标记为 `missing_handicap_line`。

## 在 ChatGPT Pro 中分析

1. 先打开 `manifest.json`，确认没有意外文件，检查 `privacy`、`phaseBoundary` 和各文件哈希。
2. 上传 `manifest.json`、`data_dictionary.md`、`prompt.md` 及全部 CSV 分片。
3. 告诉 ChatGPT：“按 `prompt.md` 执行，先做边界和行数检查，未通过前不要计算命中率。”
4. 要求输出分析过程用到的合并表或异常清单时，另存为新文件；不要覆盖原始包。
5. 把结果作为影子审计意见保存，经过人工复核后再决定是否修改网站规则。

不要上传 `server-data`、`.env`、浏览器资料、ChatGPT 数据导出 ZIP、日志全量或任何密钥。此导出器采用字段白名单，默认不包含聊天记录、账号信息、联系方式、访问令牌、Cookie、API Key、源 URL 和图片地址；上传前仍应人工抽查 `manifest.json` 和 CSV 表头。

## 时间与统计注意事项

- `cutoff_at` 优先取已知停售/锁定时间中的最早值；没有明确值时才回退到开赛时间，并标记 `cutoff_quality=kickoff_fallback`。
- 原始赔率必须满足 `observed_at <= cutoff_at`；原始预测必须满足 `prediction_captured_at <= cutoff_at`。越界记录不导出，只在 manifest 中计数。
- `matches.csv` 不含 `status`、比分或结果。赛后字段只在 `settlements` 中出现。
- 正式推荐与分析参考必须分开统计。一次比赛的多次快照不能被当成多场比赛来放大样本。
- Brier、Log Loss、校准误差、命中率和 ROI 回答不同问题，应同时报告样本量和置信范围；小样本结论只能进入后续影子验证。

## 自动化的后续路径

当手动审计连续多批稳定后，再单独设计 API 流程：服务器生成同样的赛前数据包，API 只返回固定 JSON 风险复核，不允许改写模型概率或推荐方向；请求必须保存模型版本、提示词版本、输入哈希、cutoff 和输出审计字段。这个阶段不复用 Pro 登录态，也不把 API Key 放进前端或导出包。
