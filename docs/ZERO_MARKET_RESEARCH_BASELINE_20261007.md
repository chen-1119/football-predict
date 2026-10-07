# 独立零市场研究基线

新增模块 `scripts/zeroMarketResearchBaseline.cjs` 是纯研究计算，未接入服务器、PG、模型registry、正常publisher或正式V3。代码测试使用合成数据。代码独审通过后，2026年10月7日14:50（北京）另完成一次真实277条标签的受限研究拟合，今日目标未运行forecast或冻结。本次不证明准确率或命中率提升。

## 数据准入

必须显式提供固定CC0原件/许可/FT格式证据hash、source namespace、源内研究实体及逐行普通FT标签。实体ref是固定来源内部引用，不能当canonical球队或官方事件ID。metadata approval须明确研究用途、研究实体映射、部分覆盖、venue-agnostic策略、审核人/时刻，并绑定全体source/entities/rows的稳定hash。缺批准默认blocked。

普通FT格式可以在批准后用于受限前瞻研究，不冒充可信官方90分钟终场。输入不允许市场、赔率、SP或阵容/伤病/体能/xG字段。source rows的neutral、historicalAsOf、actualEndedAt必须保留null。knowledge是原件/必要格式证据/实际审核后新产生的可用时点；不能回填旧时点。函数fit和forecast使用真实运行时钟，调用方不能指定过去的拟合/预测时间。

旧历史asOf仍未知，禁止过去回测。当前巴甲标签最近至9月20日；9月21日起和全部赛事连续性未齐。缺真实结束时刻、球员分钟与完整赛程，不生成restDays或体能贡献。芬兰/官网复用许可unknown的资料目前只作metadata引用，不混入此CC0训练输入。

## 数学

对每队拟合攻击量a与防守失球量d，另拟合共享截距μ：`λ(home)=exp(μ+a(home)+d(away))`，反向对称。正d代表对手更容易得分。攻击和防守各自和为0，使截距可识别。没有主场参数；venue-agnostic是研究建模策略，保留原neutral=null，不能推断事实中立场或neutral=false。

目标函数是每场两队Poisson负对数似然的均值（含log(goal!)），加`regularization/(2×队数)×Σ(a²+d²)`。确定性全批梯度将候选点投影到“和为零∩box”，截距投影到有界区间；Armijo用实际投影方向控制目标下降。以约束梯度映射判定KKT收敛，另报告原始梯度、实际初末目标、完成迭代和停止原因。非收敛制品只保留拟合诊断，不能forecast/freeze。

artifact验证从完整配置与排序标签重放同一纯确定性optimizer，精确核对全部参数、初末目标、算法、迭代、停止、梯度和收敛报告；不只核一个末目标。顶层、参数/配置/报告/invariants键与诚实状态均严格限定。未知字段、删配置或重封伪造拟合报告不能准入。plain JSON前置护栏拒绝循环、getter、稀疏数组和过深/过大输入。没有市场先验、手调因子混合或Dixon-Coles相关修正；这是独立Poisson，不称DC参数拟合或完整训练模型上线。

数组仅接受本realm或真实cross-realm的原生Array.prototype及原生构造器/方法合同，拒绝subclass与prototype覆写；自身enumerable键必须连续为0至length−1。空洞不能以同数量的named属性掩盖，检查先于不可信数组方法调度。

一个全局比分grid派生HAD、整数HHAD与全局比分Top3。HHAD按`主队进球+整数让球`比较客队。保留截断前rawMass、tailMass和条件归一化概率含义，不隐藏尾部。未跨HAD/HHAD比较裸p选择主方向；primary/companion始终null，formalEligible=false。

## 新未来记录

forecast除有效研究artifact外，还需新的有序目标来源/实体alias与事件时间映射审批，绑定全event hash和原证据SHA、真实observed/known clock、未来开赛及开放销售截止。事件审核必须晚于事件观测；已批准knownAt不晚于实际预测。训练标签knownAt严格早于真实fit开始，fit完成即modelAvailableAt。记录forecastStartedAt、forecastCompletedAt；计算结束再次检查实际钟、cutoff/kickoff/knowledge，asOf/frozenAt均为完成时刻，跨截止正常blocked。严格排除训练中同source record或同日期/有序实体目标；源码不提供回溯asOf。输出是独立研究freeze，市场比较和全部球队因子为空；不修改旧12:05影子和线上冻结。

metadata批准是明确的研究使用合同，hash仅提供内容绑定，不是官方provider签名或权限证明。root须先独审代码，再针对真实数据明确作研究metadata审批。模块本身不批准来源、训练数据或正式推荐。

## 验证与边界

定向测试覆盖真实合成参数拟合/目标下降、常数标签的解析均值、主客对称、Poisson原始质量、HAD/整数HHAD同grid关系、尾部、Top3、未知字段/身份/时钟/市场拒绝、重复目标、artifact绑定及无审批默认blocked。它们不是实际联赛预测效果。

正式模型500个同场配对、6个独立窗、3个残差fold、校准/前瞻/市场增益与来源合同保持不变。现V3 neutral/ablation门禁、原市场先验及权重均未修改。下一阶段应在实际审批后用新未来研究记录及后来同事件可信结果做配对Brier/logloss；社区FT研究指标独立标记，不进入官方90分钟正式命中率。

## 本次受限真实拟合

固定CC0来源的277个普通FT格式标签与20个源内研究实体，经逐行原字节、日期、比分和有序名字审核后，在实际新审核时刻取得研究可用性。没有将原件获取、格式核查、旧影子生成时间当作训练可用时点。实际fit为2026-10-07T06:50:37.442Z至06:50:37.483Z，模型可用时刻等于fit完成时刻。

固定配置下完成517次迭代，约束梯度范数约9.93417×10⁻⁸，按既定1×10⁻⁷阈值收敛。训练目标由1.4266917562142405降至1.379560473399431；完整确定性参数与优化报告重放，以及独立1428项资料/合同核验通过。训练目标下降仅证明这批资料的拟合计算，不是样本外预测效果、校准或命中率提升。

最近标签仍为9月20日，连续覆盖、实际结束时刻、历史可用性与官方90分钟赛果均未知。未生成今日预测，未接入生产模型、registry或publisher。审批、原件、逐行输入、拟合制品与原始执行回执保存在私有研究目录，不提交Git。后续先补新未来目标的可信别名/时间/销售审核，再封存前瞻样本；阵容、伤病、xG和体能仍为空。
