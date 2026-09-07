# 固定 A/B/C 校准诊断报告

2026-09-07：补齐 Q3-05 的私有历史研究校准图，不改变模型参数、原研究版本、生产接口、推荐或结算。

## 生成与边界

```powershell
npm.cmd run verify:calibration-report
npm.cmd run research:calibration-report -- ../prediction-quality-q3-20260907/outputs/fixed-abc-historical-v2-complete.json outputs/fixed-abc-calibration-new.html
npm.cmd run verify:calibration-report-browser -- outputs/fixed-abc-calibration-new.html
```

浏览器检查沿用 `REVIEW_QA_PLAYWRIGHT_MODULE` / `REVIEW_QA_CHROMIUM_EXECUTABLE` 环境变量。已有输出拒绝覆盖，新报告只允许位于当前工作树 outputs 内；不会上传私有研究产物。

输入为既有 `fixed-abc-research-run-v2`。读取和核对外层、研究、消融内容哈希及原协议，执行独立语义检查：固定 A/B/C、HAD 三类、全量/共同可判定/筛选分母、10 个固定分箱、空箱空值、实际类别总数、校准前后与路线之间的类别人群一致性、研究禁晋级状态及校正区间。内容哈希不是独立来源或首次收到时钟证明。

报告包含九张主/平/客校准图、全量精确分箱表、校准前后标记、共同可判定命中与全量概率误差、各路线固定筛选覆盖率、相对市场的日期块区间。图表不切换为有利子集；三路线都用原完整测试 3,636 场。命中对比仍为共同可判定 3,624 场，不拼接分母。

报告标明历史已被查看、缺源端时钟、不是独立盲测/前瞻验证；分箱没有置信区间，不把极少样本的单点当作可靠性证据。C 的修正权重为 0，微小变化是市场校准，不是球队模型优势。B/C 的总体成对误差区间保持原产物，不重新拟合或因测试结果改参数。

## 实际验证

- 30 项实际生成器/校验器回归，包括重新计算哈希后仍拒绝分母/分箱不一致、空箱误零、概率范围、非法数量、类别分布漂移、XSS、研究边界、区间方法漂移及最终测试标签泄漏声明。
- 原 v2 完整产物（408,433 字节，哈希 `6a8de239dcdc2d5f9f318f2f1b203d65ec22ec949f2938d151e15b778cc8f74d`）实际生成成功，没有改写源 JSON。
- 三尺寸 390/768/1440，共 9 个浏览器场景通过；九图可见、标签与标记不越界、全部分箱表打开无页面横向溢出、Enter 操作有效。没有外部请求或运行错误；已查看手机 A 和桌面 C 截图。
- 报告输出 `outputs/fixed-abc-calibration-20260907-v2.html`，38,962 字节，报告哈希 `1c8ea17637d1df8c33694edc77f4e90821b1b72c028325235b34e107884e8abe`。
- 独立新路径重放 HTML 字节完全一致；真实 CLI 对已有报告返回失败，原报告未被覆盖。

这是本地私有研究交付，不是线上研究页面接入验收。Q3-05 的完整产品呈现、其他玩法、真实时钟与独立前瞻仍未完成。该补丁不在已签名且正在发布的 r695 中。
