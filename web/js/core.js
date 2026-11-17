/* =========================================================================
 * core.js — 本心盘口算法内核（纯离线，无外部依赖）
 *   · 纯函数：输入一场比赛 → 输出盘口 / 场景 / 仲裁 / 评分 / 推荐方向
 *   · 全部系数与硬编码阈值集中在 PARAM_DEFS（可在「调参中心」调）
 *   · 全部映射表集中在 DEFAULT_LIB（联赛 / 场景方向 / 加减分库 / 位置系数 / 转会窗口）
 *   · 数据层：记录库、参数、映射表的本地持久化与版本迁移
 *
 * 对外只暴露一个对象：window.Core。分区见文件内的 `/* ---- N. 标题 ---- *\/` 注释。
 * ========================================================================= */
(function (global) {
  'use strict';

  /* ---------------- 1. 可调参数（系数 + 硬编码） ---------------- */
  // type: num | int | bool   step 用字符串以免浮点误差
  const PARAM_DEFS = [
    // —— 攻防积分 ——
    { k: 'AD_DFW', g: '攻防积分', n: 'D值权重', d: 0.35, s: '0.01', min: 0, max: 2,
      why: '攻防积分核心系数：主/客队场均（进球−失球）乘以该权重后再限幅 ±0.8' },
    { k: 'AD_BIGWIN_DIFF', g: '攻防积分', n: '大胜判定净胜球', d: 3, s: '1', min: 1, max: 10, int: 1,
      why: '单场净胜球 ≥ 该值时，该场进球与失球都打 0.8 折（抑制大胜样本虚高）' },
    { k: 'AD_BIGWIN_FACTOR', g: '攻防积分', n: '大胜折算系数', d: 0.8, s: '0.01', min: 0, max: 1,
      why: '大胜场次的进球/失球折扣系数' },
    { k: 'AD_CAP', g: '攻防积分', n: 'D值限幅', d: 0.8, s: '0.05', min: 0.1, max: 3,
      why: 'MEDIAN(-AD_CAP, D×强度×权重, +AD_CAP) 的上下限' },
    { k: 'AD_BIGWIN_ROUND', g: '攻防积分', n: '结果保留位数', d: 8, s: '1', min: 2, max: 12, int: 1,
      why: 'ROUND(...,N) 的 N，默认 8 位以避免逐位对账时的精度损失' },
    { k: 'STRONG_OPP_RATIO', g: '攻防积分', n: '强对手判定比例', d: 1 / 3, s: '0.01', min: 0, max: 1,
      why: '对手平均排名 ≤ 球队总数×该比例 → 对手强度系数取“强”' },
    { k: 'STRONG_OPP_MUL', g: '攻防积分', n: '强对手系数', d: 1.1, s: '0.01', min: 0.5, max: 2,
      why: '面对强敌时数据含金量加成' },
    { k: 'WEAK_OPP_RATIO', g: '攻防积分', n: '弱对手判定比例', d: 2 / 3, s: '0.01', min: 0, max: 1,
      why: '对手平均排名 ≥ 球队总数×该比例 → 对手强度系数取“弱”' },
    { k: 'WEAK_OPP_MUL', g: '攻防积分', n: '弱对手系数', d: 0.85, s: '0.01', min: 0.2, max: 1.5,
      why: '面对弱旅时数据含金量折扣' },
    { k: 'SAMPLE_FULL_GAMES', g: '攻防积分', n: '样本满场次', d: 6, s: '1', min: 1, max: 20, int: 1,
      why: 'MIN(1, 场次/该值) 场次削弱系数。默认 6 —— 少于 6 场时按比例削弱该队攻防数据的可信度' },

    // —— 主战绩系数偏差 ——
    { k: 'FORM_A', g: '主战绩系数', n: '基础系数 a', d: 0.65, s: '0.01', min: 0, max: 3, lib: 'B21',
      why: '基础系数 = a + K × b，K 为主场场均得分/客场场均得分' },
    { k: 'FORM_B', g: '主战绩系数', n: '斜率系数 b', d: 0.2, s: '0.01', min: 0, max: 3, lib: 'B22',
      why: '主客战力比 K 的放大斜率' },
    { k: 'FORM_LO', g: '主战绩系数', n: '系数下限', d: 0.7, s: '0.01', min: 0, max: 3, lib: 'B23',
      why: 'MEDIAN(下限, 基础系数, 上限) 的下限' },
    { k: 'FORM_HI', g: '主战绩系数', n: '系数上限', d: 1.3, s: '0.01', min: 0, max: 5, lib: 'B24',
      why: 'MEDIAN(下限, 基础系数, 上限) 的上限' },
    { k: 'FORM_SMOOTH', g: '主战绩系数', n: '样本平滑阈值（场）', d: 5, s: '1', min: 1, max: 30, int: 1, lib: 'B25',
      why: '主场场次 < 该值时按比例向 1 收缩：1+(限幅−1)×场次/阈值' },
    { k: 'FORM_LATE_ROUNDS', g: '主战绩系数', n: '赛季末修正轮数', d: 5, s: '1', min: 0, max: 20, int: 1, lib: 'B26',
      why: '剩余轮次 < 该值 时启用收敛因子（同时决定战意是否生效）' },
    { k: 'FORM_CONVERGE', g: '主战绩系数', n: '收敛因子', d: 0.6, s: '0.01', min: 0, max: 1, lib: 'B27',
      why: '赛季末：1+(平滑系数−1)×该因子' },
    { k: 'FORM_EMPTY', g: '主战绩系数', n: '空场强制系数', d: 0.5, s: '0.01', min: 0, max: 2, lib: 'B28',
      why: '是否空场 = TRUE 时，最终系数被强制替换为该值' },
    { k: 'FORM_STEP', g: '主战绩系数', n: '偏差折算步长', d: 0.125, s: '0.001', min: 0.001, max: 1,
      why: '最终系数每偏离 1.0 这么多，折算成一个盘口步长的偏差' },

    // —— 排名分差 ——
    { k: 'RANK_W', g: '排名分差', n: '排名权重', d: 0.6, s: '0.01', min: 0, max: 3, lib: 'B29',
      why: '排名净分差 = ((客排名−主排名)/(N−1)) × 该权重 × 区间衰减' },
    { k: 'RANK_LO', g: '排名分差', n: '净分差下限', d: -0.5, s: '0.05', min: -5, max: 0, lib: 'B30',
      why: 'MEDIAN 下限，避免排名一项过度主导' },
    { k: 'RANK_HI', g: '排名分差', n: '净分差上限', d: 0.5, s: '0.05', min: 0, max: 5, lib: 'B31',
      why: 'MEDIAN 上限' },
    { k: 'RANK_TIER_LO', g: '排名分差', n: '上游/中游分界排名', d: 6, s: '1', min: 1, max: 30, int: 1,
      why: '当前排名 ≤ 该值 → 上游（默认 6，按 18~20 队联赛推的，可按你的联赛规模改）' },
    { k: 'RANK_TIER_HI', g: '排名分差', n: '中游/下游分界排名', d: 12, s: '1', min: 1, max: 40, int: 1,
      why: '当前排名 ≤ 该值 → 中游，否则下游' },
    { k: 'RANK_TIER_MAX', g: '排名分差', n: '区间判定上限排名', d: 18, s: '1', min: 1, max: 40, int: 1,
      why: '排名 > 该值 一律按下游处理（默认 18）' },

    // —— 加减分项 ——
    { k: 'ADJ_CAP', g: '加减分项', n: '伤病/停赛封顶', d: 0.6, s: '0.05', min: 0, max: 3,
      why: 'MEDIAN(-封顶, 伤病×阵容深度, 0)：单人项最大扣分' },
    { k: 'ADJ_MOTIV_AWAY', g: '加减分项', n: '客队战意折扣', d: 0.5, s: '0.05', min: 0, max: 1,
      why: '客队战意修正 = 战意分 × 该系数（客队没有主场加成，战意权重减半）' },

    // —— 盘口 / 场景 ——
    { k: 'HCP_STEP', g: '盘口与场景', n: '盘口步长', d: 0.125, s: '0.001', min: 0.001, max: 1,
      why: 'FLOOR(ABS(净分差)/步长) → 盘口档位；同时用于“临界心盘”判定' },
    { k: 'HCP_UNIT', g: '盘口与场景', n: '每档盘口头', d: 0.25, s: '0.01', min: 0.01, max: 1,
      why: '档位 × 每档 = 盘口数值（1 档 = 0.25 球）' },
    { k: 'HCP_CAP', g: '盘口与场景', n: '盘口封顶', d: 3, s: '0.25', min: 0.25, max: 6,
      why: '短长期净分差折算成盘口球数时的封顶，默认 3 球' },
    { k: 'WATER_SUM', g: '盘口与场景', n: '上下盘水位之和', d: 2, s: '0.01', min: 1.5, max: 2.5,
      why: '买下盘时用来估算下盘水位：下盘水位 = 本参数 − 记录的上盘水位。真实盘口的两边水位之和一般在 1.8~2.0，' +
        '想更保守可以调到 1.9' },
    { k: 'W_ULTRA_LOW', g: '盘口与场景', n: '超低水上限', d: 0.8, s: '0.01', min: 0, max: 3,
      why: '水位 ≤ 该值 → 超低水' },
    { k: 'W_LOW', g: '盘口与场景', n: '低水上限', d: 0.9, s: '0.01', min: 0, max: 3,
      why: '水位 ≤ 该值 → 低水' },
    { k: 'W_MID', g: '盘口与场景', n: '中水上限', d: 0.99, s: '0.01', min: 0, max: 3,
      why: '水位 ≤ 该值 → 中水' },
    { k: 'W_HIGH', g: '盘口与场景', n: '高水上限', d: 1.09, s: '0.01', min: 0, max: 3,
      why: '水位 ≤ 该值 → 高水，否则超高水' },
    { k: 'MOVE_SMALL', g: '盘口与场景', n: '微调上限', d: 0.25, s: '0.05', min: 0, max: 3,
      why: 'ABS(终盘−初盘) ≤ 该值 → 微调' },
    { k: 'MOVE_MID', g: '盘口与场景', n: '中幅上限', d: 0.5, s: '0.05', min: 0, max: 3,
      why: 'ABS(终盘−初盘) ≤ 该值 → 中幅' },
    { k: 'MOVE_BIG', g: '盘口与场景', n: '大幅下限', d: 0.75, s: '0.05', min: 0, max: 3,
      why: 'ABS(终盘−初盘) ≥ 该值 → 大幅' },

    // —— 评分与置信度 ——
    { k: 'DEV_T1', g: '评分与置信度', n: '偏差评分1档', d: 0.25, s: '0.05', min: 0, max: 3,
      why: 'ABS(初盘−心盘) ≤ 该值 → 偏差评分 1' },
    { k: 'DEV_T2', g: '评分与置信度', n: '偏差评分2档', d: 0.5, s: '0.05', min: 0, max: 3,
      why: 'ABS(初盘−心盘) ≤ 该值 → 偏差评分 2' },
    { k: 'DEV_T3', g: '评分与置信度', n: '偏差评分3档', d: 0.75, s: '0.05', min: 0, max: 3,
      why: 'ABS(初盘−心盘) ≥ 该值 → 偏差评分 3' },
    { k: 'LINK_HI', g: '评分与置信度', n: '联动评分·高', d: 3, s: '0.5', min: 0, max: 10,
      why: '盘口与水位同向（升盘低水 / 降盘高水）时的联动分' },
    { k: 'LINK_LO', g: '评分与置信度', n: '联动评分·背离', d: 0, s: '0.5', min: 0, max: 10,
      why: '盘口与水位反向时的联动分' },
    { k: 'LINK_MID', g: '评分与置信度', n: '联动评分·中性', d: 1, s: '0.5', min: 0, max: 10,
      why: '其余情况的联动分' },
    { k: 'ARB_OK', g: '评分与置信度', n: '仲裁评分·三方一致', d: 2, s: '0.5', min: 0, max: 10,
      why: 'v14 新口径：机构让球方、长期实力、短期突发三者同向时的得分（旧口径的「信号有效」也用这个）' },
    { k: 'ARB_MINOR', g: '评分与置信度', n: '仲裁评分·短期小分歧', d: 1.5, s: '0.5', min: 0, max: 10,
      why: 'v14：长期支持机构让球方，但短期突发小幅反向（|加减| &lt; 一票否决阈值）' },
    { k: 'ARB_DIV', g: '评分与置信度', n: '仲裁评分·长期背离', d: 1, s: '0.5', min: 0, max: 10,
      why: 'v14：机构让球方向与模型长期实力相反，但短期突发支持它（可能是信息差）' },
    { k: 'ARB_REV', g: '评分与置信度', n: '仲裁评分·短期重大反向', d: 0.5, s: '0.5', min: 0, max: 10,
      why: 'v14：长期支持机构让球方，但短期突发明显反向（|加减| ≥ 一票否决阈值）→ 第 2 步止步' },
    { k: 'ARB_TOTAL', g: '评分与置信度', n: '仲裁评分·全面背离（真否决）', d: 0, s: '0.5', min: 0, max: 10,
      why: 'v14：机构让球方向 与 长期+短期 全部相反 —— 最典型的诱盘，给 0 分并直接否决' },
    { k: 'ARB_THIN', g: '评分与置信度', n: '仲裁评分·方向证据不足', d: 1, s: '0.5', min: 0, max: 10,
      why: 'v14：机构开平手盘、或长期三项合计接近 0，仲裁没有判断对象 → 给中性分，不奖不罚' },
    { k: 'ARB_VETO', g: '评分与置信度', n: '仲裁评分·旧口径一票否决', d: 0.5, s: '0.5', min: 0, max: 10,
      why: '仅当「仲裁口径 = 旧口径」时使用：强背离时的得分' },
    { k: 'ARB_BAD', g: '评分与置信度', n: '仲裁评分·旧口径信号无效', d: 0, s: '0.5', min: 0, max: 10,
      why: '仅当「仲裁口径 = 旧口径」时使用：信号无效时的得分' },
    { k: 'TIME_T4', g: '评分与置信度', n: '时间评分·24h+', d: 2, s: '0.5', min: 0, max: 10,
      why: '（终盘时间−初盘时间）≥ 24 小时的得分' },
    { k: 'TIME_T3', g: '评分与置信度', n: '时间评分·6h+', d: 1.5, s: '0.5', min: 0, max: 10,
      why: '≥ 6 小时' },
    { k: 'TIME_T2', g: '评分与置信度', n: '时间评分·3h+', d: 1, s: '0.5', min: 0, max: 10,
      why: '≥ 3 小时' },
    { k: 'TIME_T1', g: '评分与置信度', n: '时间评分·不足3h', d: 0.5, s: '0.1', min: 0, max: 10,
      why: '< 3 小时' },
    { k: 'TIME_DEF', g: '评分与置信度', n: '时间评分·缺失默认', d: 1, s: '0.5', min: 0, max: 10,
      why: '初盘/终盘时间任一为空时的默认分' },
    { k: 'CONSENSUS_MIN', g: '评分与置信度', n: '信号一致数量门槛', d: 2, s: '1', min: 1, max: 3, int: 1,
      why: '攻防/主战绩/排名 中“正”的个数 ≥ 该值 → 信号有效' },
    { k: 'VETO_ABS', g: '评分与置信度', n: '一票否决阈值', d: 0.3, s: '0.05', min: 0, max: 3,
      why: '加减方向 ≠ 正 且 ABS(加减净分差) ≥ 该值 → 强背离（诱盘）' },
    { k: 'STRONG_SCORE', g: '评分与置信度', n: '强信号分界', d: 7, s: '0.5', min: 0, max: 20,
      why: '综合评分 ≥ 该值 → 信号强度「强」' },
    { k: 'MED_SCORE', g: '评分与置信度', n: '中信号分界', d: 4, s: '0.5', min: 0, max: 20,
      why: '综合评分 ≥ 该值 → 「中」，否则「弱」' },
    /* ★ v15 删除「过早投注天数 TIMING_NOTE_DAYS」：引擎从未读过它（调了完全没反应），
     *   留着只会让人白忙。以后真要用，再作为算法参数加回来。 */

    /* ---- 模型置信度（每一场、基于场景）---- */
    { k: 'ITERATION', g: '模型置信度', n: '模型迭代版本号', d: 12, s: '1', min: 1, max: 999, int: 1,
      why: '统计分项「模型置信度」的名字后缀。每次按新表迭代就 +1，指标会自动改名（v12 → v13），' +
        '历史记录里会保留当时的版本号，方便对比同一场比赛在不同版本下的置信度变化' },
    { k: 'CONF_W_SCENE', g: '模型置信度', n: '① 场景证据权重', d: 45, s: '5', min: 0, max: 100,
      why: '同场景历史（按场景方向买）的命中率与 Wilson 下界 → 这一块最多多少分' },
    { k: 'CONF_W_DIR', g: '模型置信度', n: '② 方向证据权重', d: 25, s: '5', min: 0, max: 100,
      why: '四票一致数量（攻防/主战绩/排名/加减）→ 最多多少分；信号无效打 6 折，强背离归零' },
    { k: 'CONF_W_CLARITY', g: '模型置信度', n: '③ 场景清晰度权重', d: 15, s: '1', min: 0, max: 100,
      why: '标准 8 场景满额；中水四场景 60%；盘口不变 33%；平手或错误 0；再按偏差评分缩放' },
    { k: 'CONF_W_STRUCT', g: '模型置信度', n: '④ 盘口结构权重', d: 15, s: '1', min: 0, max: 100,
      why: '联动评分 + 时间评分 + 变动幅度 三小块合计最多多少分' },
    { k: 'CONF_PRIOR_N', g: '模型置信度', n: '先验样本量', d: 4, s: '1', min: 0, max: 50,
      why: '小样本收缩：把同场景命中率按这个「虚拟场次」往先验胜率拉，避免 1 胜 0 负就给出 100% 置信' },
    { k: 'CONF_PRIOR_P', g: '模型置信度', n: '先验胜率', d: 0.5, s: '0.05', min: 0, max: 1,
      why: '先验命中率（一般填 0.5；若你认为整体偏上盘，可调到 0.55）' },
    { k: 'CONF_LO_FLOOR', g: '模型置信度', n: '下界映射下限', d: 0.25, s: '0.05', min: 0, max: 1,
      why: '收缩后的 Wilson 下界 ≤ 该值 → 场景证据得 0 分（想更宽松就调低）' },
    { k: 'CONF_LO_CEIL', g: '模型置信度', n: '下界映射上限', d: 0.55, s: '0.02', min: 0, max: 1,
      why: '收缩后的 Wilson 下界 ≥ 该值 → 场景证据拿满分（想更严格就调高）' },
    { k: 'CONF_CAP_VETO', g: '模型置信度', n: '强背离封顶', d: 25, s: '5', min: 0, max: 100,
      why: '一票否决的场次，置信度不允许超过该值' },
    { k: 'CONF_CAP_NEUTRAL', g: '模型置信度', n: '平手或错误封顶', d: 30, s: '5', min: 0, max: 100,
      why: '场景落到「平手或错误」时封顶' },
    { k: 'CONF_CAP_MIDWATER', g: '模型置信度', n: '中水不判定封顶', d: 55, s: '5', min: 0, max: 100,
      why: '中水场景但二次判定不成立时封顶' },
    { k: 'CONF_CRIT_MUL', g: '模型置信度', n: '心盘临界折扣', d: 0.9, s: '0.05', min: 0.1, max: 1,
      why: '心盘正好落在两个盘口的分界线上时，整体乘以该系数' },
    { k: 'CONF_T1', g: '模型置信度', n: '高置信分界', d: 80, s: '5', min: 0, max: 100,
      why: '≥ 该值 → 高置信（可正常出手）' },
    { k: 'CONF_T2', g: '模型置信度', n: '中高分界', d: 65, s: '5', min: 0, max: 100,
      why: '≥ 该值 → 中高（控制仓位）' },
    { k: 'CONF_T3', g: '模型置信度', n: '中等分界', d: 50, s: '5', min: 0, max: 100,
      why: '≥ 该值 → 中等（小注或观望）' },
    { k: 'CONF_T4', g: '模型置信度', n: '偏弱分界', d: 35, s: '5', min: 0, max: 100,
      why: '≥ 该值 → 偏弱（建议观望）；低于它 → 低置信（放弃）' },

    /* ============ 伤停量化（依据「本次优化规则」） ============ */
    { k: 'EDGE_NUM', g: '伤停量化', n: '① 边缘候选·号码下限', d: 40, s: '1', min: 1, max: 99, int: 1,
      src: '辅助页 2-1',
      why: '号码 > 该值 <b>且</b> 身价处于队内后 10% → 标记边缘候选（只用来算基数，不影响伤停损失求和）' },
    { k: 'EDGE_PCT', g: '伤停量化', n: '① 边缘候选·身价分位', d: 0.10, s: '0.01', min: 0, max: 0.5,
      why: '队内身价排序后百分之几算「后段」。两个条件必须同时成立才判边缘' },
    { k: 'POOL_MIN', g: '伤停量化', n: '① 有效池最低人数（保护1）', d: 18, s: '1', min: 11, max: 30, int: 1,
      why: '剔除边缘候选后如果人数低于它 → 按身价从低到高放回，保证有效池人数' },
    { k: 'GK_KEEP', g: '伤停量化', n: '① 门将保护人数（保护2）', d: 2, s: '1', min: 1, max: 5, int: 1,
      why: '有效池门将 ≤ 该值时，门将强制保留，不判边缘' },

    { k: 'W_START', g: '伤停量化', n: '② W 上一场首发', d: 1.00, s: '0.05', min: 0, max: 2,
      src: '辅助页 2-2 W_i',
      why: '出场优先级权重：上一场首发' },
    { k: 'W_SUB_PLAYED', g: '伤停量化', n: '② W 替补有上场', d: 0.45, s: '0.05', min: 0, max: 2,
      why: '上一场替补且有上场时间' },
    { k: 'W_BENCH', g: '伤停量化', n: '② W 替补坐板凳', d: 0.15, s: '0.05', min: 0, max: 2,
      why: '进了大名单但没上场' },
    { k: 'W_OUT', g: '伤停量化', n: '② W 未进大名单', d: 0.02, s: '0.01', min: 0, max: 2,
      why: '上一场连大名单都没进' },
    { k: 'W_NEW', g: '伤停量化', n: '② W 新援', d: 0.60, s: '0.05', min: 0, max: 2,
      why: '刚转会、本队没有上一轮出场记录' },

    { k: 'LOSS_T1', g: '伤停量化', n: '③ 伤病分档 T1', d: 0.04, s: '0.01', min: 0, max: 1,
      src: '辅助页 2-3',
      why: 'Loss_Est &lt; 该值 → 「阵容齐整或无影响缺阵」（0）' },
    { k: 'LOSS_T2', g: '伤停量化', n: '③ 伤病分档 T2', d: 0.10, s: '0.01', min: 0, max: 1,
      why: '&lt; 该值 → 「单名普通主力缺阵」（−0.1）' },
    { k: 'LOSS_T3', g: '伤停量化', n: '③ 伤病分档 T3', d: 0.18, s: '0.01', min: 0, max: 1,
      why: '&lt; 该值 → 「单名绝对核心缺阵」（−0.25）' },
    { k: 'LOSS_T4', g: '伤停量化', n: '③ 伤病分档 T4', d: 0.27, s: '0.01', min: 0, max: 1,
      why: '&lt; 该值 → 「双核或攻防双主力缺阵」（−0.4）' },
    { k: 'LOSS_T5', g: '伤停量化', n: '③ 伤病分档 T5', d: 0.35, s: '0.01', min: 0, max: 1,
      why: '&lt; 该值 → 「三核缺阵或半套主力」（−0.5）；≥ 该值 → 「大面积伤病潮」（−0.6）' },

    { k: 'DEPTH_XI', g: '伤停量化', n: '④ 深度·首发人数 N', d: 11, s: '1', min: 5, max: 20, int: 1,
      why: '「固有板凳厚度」口径：把身价最高的 N 人当首发，剩下的人算替补席' },
    { k: 'DEPTH_HI', g: '伤停量化', n: '④ 深度·雄厚阈值（squad）', d: 0.28, s: '0.01', min: 0, max: 2,
      why: '<b>替补平均身价 ÷ 首发平均身价</b> ≥ 该值 → 「深度雄厚」（×0.7）。' +
        '默认 0.28 是按六大联赛 114 支球队实测的 80 分位定的（约 20% 球队算雄厚）' },
    { k: 'DEPTH_LO', g: '伤停量化', n: '④ 深度·薄弱阈值（squad）', d: 0.19, s: '0.01', min: 0, max: 2,
      why: '≥ 该值 → 「深度一般」（×1.0）；低于它 → 「深度薄弱」（×1.4）。默认是按 20 分位定的' },
    { k: 'DEPTH_RES_HI', g: '伤停量化', n: '④ 深度·雄厚阈值（residual 旧口径）', d: 0.88, s: '0.01', min: 0, max: 1,
      why: '只有当「映射表 → 阵容深度口径」选 <b>residual（规则原文）</b> 时才生效。' +
        '⚠ 该口径下 ResidualRatio ≡ 1 − Loss_Est，与伤病等级同源，会重复惩罚' },
    { k: 'DEPTH_RES_LO', g: '伤停量化', n: '④ 深度·薄弱阈值（residual 旧口径）', d: 0.75, s: '0.01', min: 0, max: 1,
      why: '同上，仅在 residual 口径下生效' },
    { k: 'DEPTH_FORCE', g: '伤停量化', n: '④ 无伤病时强制「深度一般」', d: 1, s: '1', min: 0, max: 1, int: 1,
      why: '规则原文的保护规则 1。<b>1 = 开启</b>（无伤病一律输出「深度一般」），<b>0 = 关闭</b>' +
        '（按球队真实板凳厚度输出）。注意：无伤病时伤病分本来就是 0，乘数不影响结果，' +
        '所以关掉它只是让「深度」这一栏更如实地反映球队属性，不会凭空产生红利' },
  ];

  /* ---------------- 2. 映射表（「调参中心 → 映射表」里可改） ---------------- */
  const DEFAULT_LIB = {
    /** 联赛参数：N 球队总数 / coef 联赛系数 / R 赛季轮数 / cap 上限 */
    leagues: {
      '英超': { N: 20, coef: 1.00, R: 38, cap: 1.2 },
      '西甲': { N: 20, coef: 1.00, R: 38, cap: 1.2 },
      '德甲': { N: 18, coef: 1.05, R: 34, cap: 1.2 },
      '意甲': { N: 20, coef: 0.85, R: 38, cap: 1.2 },
      '法甲': { N: 18, coef: 0.90, R: 38, cap: 1.2 },
      '英冠': { N: 24, coef: 0.75, R: 46, cap: 1.2 },
      '葡超': { N: 18, coef: 0.90, R: 34, cap: 1.2 },
    },
    /** 排名区间对阵衰减：主队区间 × 客队区间 → 系数 */
    decay: [
      { h: '上游', a: '上游', v: 1.00 }, { h: '上游', a: '中游', v: 0.90 },
      { h: '上游', a: '下游', v: 0.80 }, { h: '中游', a: '中游', v: 0.85 },
      { h: '中游', a: '下游', v: 0.70 }, { h: '下游', a: '下游', v: 0.50 },
    ],
    // 盘口对照表
    plate: [
      [0.25, '平半'], [0.5, '半球'], [0.75, '半一'], [1, '一球'],
      [1.25, '一球/一球半'], [1.5, '一球半'], [1.75, '一球半/二球'], [2, '二球'],
      [2.25, '二球/二球半'], [2.5, '二球半'], [2.75, '二球半/三球'], [3, '三球'],
    ],
    // 加减库：历史交锋
    hist: {
      '近3次对战3胜': 0.25, '近3次对战2胜1平': 0.15, '近3次对战2胜1负': 0.05,
      '近3次对战1胜2平': 0.05, '近3次对战1胜1平1负': 0, '近3次对战3平': 0,
      '近3次对战1胜2负': -0.05, '近3次对战2平1负': -0.05, '近3次对战1平2负': -0.15,
      '近3次对战3负': -0.25,
    },
    // 加减库：伤病
    injury: {
      '阵容齐整或无影响缺阵': 0, '单名普通主力缺阵': -0.1, '单名绝对核心缺阵': -0.25,
      '双核或攻防双主力缺阵': -0.4, '三核缺阵或半套主力': -0.5, '大面积伤病潮': -0.6,
    },
    // 加减库：停赛
    suspend: { '无停赛': 0, '首发主力红牌停赛': -0.1, '轮换球员红牌停赛': -0.05 },
    // 加减库：赛程疲劳
    fatigue: {
      '间隔4-5天': 0, '一周双赛(≤3天)': -0.125, '休息充足(≥6天)': 0.05,
      '连续2个客场': -0.1, '连续3个客场': -0.15, '下场有欧战，本场可能轮换': -0.15,
    },
    // 加减库：连赢连负
    streak: { '其他情况': 0, '连续3场胜利': 0.1, '连续3场失利': -0.1 },
    // 加减库：阵容深度倍数
    depth: { '深度雄厚': 0.7, '深度一般': 1.0, '深度薄弱': 1.4 },
    // 加减库：战意
    motive: { '争冠/保级生死战': 0.15, '争分': 0.12, '德比/死敌': 0.12, '普通': 0, '摆烂': -0.12 },
    /* ---- 伤停量化：位置命名对照（以「球员信息表」里的写法为准）---- */
    posClass: {
      '守门员': 'GK',
      '中卫': 'CB', '后卫': 'CB',
      '左后卫': 'FB', '右后卫': 'FB',
      '后腰': 'DM',
      '中前卫': 'CM', '中场': 'CM',
      '前腰': 'AM',
      '左边锋': 'WM', '右边锋': 'WM', '左中场': 'WM', '右中场': 'WM',
      '中锋': 'ST', '前锋': 'ST', '影锋': 'ST',
    },
    /* ---- 位置伤害修正系数（按位置类别；后腰 DM / 前腰 AM 是规则没列、由我补的）---- */
    posFac: { GK: 1.20, CB: 1.10, FB: 1.00, DM: 1.08, CM: 1.05, AM: 1.02, WM: 0.95, ST: 0.95 },
    /* ---- 转会窗口（可增删改）---- */
    transferWindows: [
      { lg: '英超', sum: { from: '06-15', to: '09-01', hm: '23:00', tz: 'BST' }, win: { from: '01-01', to: '02-01', hm: '23:00', tz: 'GMT' } },
      { lg: '西甲', sum: { from: '07-01', to: '09-01', hm: '23:59', tz: 'CET' }, win: { from: '01-02', to: '02-02', hm: '23:59', tz: 'CET' } },
      { lg: '意甲', sum: { from: '06-29', to: '09-01', hm: '20:00', tz: 'CET' }, win: { from: '01-02', to: '02-01', hm: '20:00', tz: 'CET' } },
      { lg: '德甲', sum: { from: '07-01', to: '09-01', hm: '20:00', tz: 'CET' }, win: { from: '01-01', to: '01-31', hm: '20:00', tz: 'CET' } },
      { lg: '法甲', sum: { from: '06-15', to: '09-01', hm: '19:59', tz: 'CET' }, win: { from: '01-01', to: '02-01', hm: '19:59', tz: 'CET' } },
    ],
    /* ---- 阵容深度口径（★ 修正重复惩罚的开关）----
     * 'squad'    = 固有板凳厚度（默认，推荐）：替补平均身价 ÷ 首发平均身价，与伤病解耦
     * 'residual' = 规则原文：1 − Loss_Est，与伤病等级同源，两乘数同向叠加 → 重复惩罚 */
    depthMode: 'squad',
    /* ---- 仲裁口径（★ 修正主队/上盘坐标系混用）----
     * 'v2'     = 以机构让球方（上盘方）为基准的方向对称检验（默认）
     * 'legacy' = 旧口径原文（纯主队视角，客让盘会整反），只留作对照 */
    arbMode: 'v2',
    /* ---- 平手盘（初盘=终盘=0球）时靠水位判上盘的口径 ----
     * 'columns'    = 平手盘时「初盘水位」记主队、「终盘水位」记客队（默认）
     * 'home'       = 两栏都是主队水位（初盘 / 终盘两个时点），低水=主队上盘、高水=客队上盘
     * 'alwaysHome' = 平手盘一律以主队为上盘，不看水位 */
    flatWaterMode: 'columns',
    /* 水位判不出来（没填 / 不全）时的兜底：'home' = 主队为上盘（默认）；'none' = 平手不推荐 */
    flatWaterDefault: 'home',
    /* 平手盘判出上盘后要不要给方向：'up' = 跟上盘（默认）；'ignore' = 只标上盘方 */
    flatWaterDir: 'up',
    /* ---- 球员库（上传/编辑；结构与 seed-players.js 一致）---- */
    /* ---- 8 大场景的「方向指向」（场景名本身就在说机构想让你买哪边）----
     * up   = 跟上盘（机构在「阻上 / 强支 / 补防」，或「诱下」时反着理解 → 上盘）
     * down = 跟下盘（机构在「诱上 / 看衰」→ 上盘是陷阱）
     * none = 无指向（盘口不变 / 中性盘）                                        */
    sceneDir: {
      '场景1': 'up',    // 深开高水升盘阻上 —— 阻上 = 机构不愿你买上盘 → 跟上盘
      '场景2': 'up',    // 深开高水降盘阻上 —— 同上
      '场景3': 'up',    // 深开低水升盘强支 —— 强支 = 明确支持上盘
      '场景4': 'down',  // 深开低水降盘诱上 —— 诱上 = 引诱你买上盘 → 反着买下盘
      '场景5': 'down',  // 浅开高水升盘诱上 —— 同上
      '场景6': 'down',  // 浅开高水降盘看衰 —— 看衰 = 看衰上盘
      '场景7': 'up',    // 浅开低水升盘补防 —— 补防 = 机构在补上盘的防守 → 跟上盘
      '场景8': 'up',    // 浅开低水降盘诱下 —— 诱下 = 引诱你买下盘 → 反着买上盘
      // v12 中水四场景：方向由「中水二次判定」的条件决定（X 一致数量）
      '中水·深升·待验证': 'cond',     // X≥3 → 上盘
      '中水·深降·诱上嫌疑': 'cond',   // X≤2 → 下盘
      '中水·浅升·诱上嫌疑': 'cond',   // X≤2 → 下盘
      '中水·浅降·看衰/保护': 'cond',  // X≥3 → 下盘
      '盘口不变·高水': 'none',
      '盘口不变·低水': 'none',
      '盘口不变·中水': 'none',
      '平手或错误': 'none',
    },
    // 场景名里的关键词 → 方向（sceneDir 缺项时的兜底，也用于生成解释文字）
    sceneKw: {
      '阻上': 'up', '强支': 'up', '补防': 'up', '诱下': 'up',
      '诱上': 'down', '看衰': 'down',
    },
  };

  /* ---------------- 3. 常量 ---------------- */
  /* ---- 公网部署的访问令牌（?k=xxx 打开一次就会记住） ---- */
  window.bxToken = (function () {
    try {
      var m = String(location.search || '').match(/[?&]k=([^&]+)/);
      if (m) {
        var t = decodeURIComponent(m[1]);
        localStorage.setItem('benxin.apiToken', t);
        return t;
      }
      return localStorage.getItem('benxin.apiToken') || '';
    } catch (e) { return ''; }
  })();
  window.withToken = function (url) {
    var t = window.bxToken;
    if (!t) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(t);
  };

  const TIERS = ['上游', '中游', '下游'];
  const LABELS = {
    deepHigh: '深开', shallow: '浅开', flat: '平手',
    water: ['超低水', '低水', '中水', '高水', '超高水'],
    scene: {
      s1: '场景1：深开高水升盘阻上', s2: '场景2：深开高水降盘阻上',
      s3: '场景3：深开低水升盘强支', s4: '场景4：深开低水降盘诱上',
      s5: '场景5：浅开高水升盘诱上', s6: '场景6：浅开高水降盘看衰',
      s7: '场景7：浅开低水升盘补防', s8: '场景8：浅开低水降盘诱下',
      // v12 新增：中水四场景（v11 之前这些一律落「中性盘」）
      m1: '中水·深升·待验证', m2: '中水·深降·诱上嫌疑',
      m3: '中水·浅升·诱上嫌疑', m4: '中水·浅降·看衰/保护',
      fh: '盘口不变·高水', fl: '盘口不变·低水', fm: '盘口不变·中水',
      neutral: '平手或错误',   // v12 改名（原「中性盘」）
    },
    arb: {
      /* ---- v14 新口径：以上盘方（机构让球方）为基准的方向对称检验 ---- */
      resonance: '三方一致：机构·长期·短期同向',
      minorSplit: '长期一致，短期小分歧',
      longDivergence: '长期背离：机构开反了长期实力',
      majorReversal: '短期反向：突发信息与机构让球冲突',
      totalDivergence: '一票否决：机构与模型全面背离',
      thin: '方向证据不足',
      /* ---- 旧口径（纯主队视角，保留可选，只作对照）---- */
      veto: '强背离：诱盘（一票否决）',
      ok: '信号有效',
      bad: '信号无效：诱盘风险',
    },
    strength: { s: '强', m: '中', w: '弱' },
  };

  /* ---------------- 4. 运行时状态 ---------------- */
  const store = {
    P: {},        // 参数
    LIB: null,    // 映射表
    rows: [],     // 比赛记录
    seq: 0,
    settings: { apiBase: '', apiKey: '', apiModel: '', ui: {} },
    history: [],  // 调参历史 / AI 回测记录
    iters: [],    // 迭代日志（模型置信度按迭代次数命名）
  };

  /* ---------------- 5. 工具 ---------------- */
  const clampMed = (lo, v, hi) => [lo, v, hi].sort((x, y) => x - y)[1];
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const round = (v, n) => { const m = Math.pow(10, n); return Math.round(v * m) / m; };
  const num = (v, dflt) => {
    if (v === null || v === undefined || v === '') return dflt === undefined ? 0 : dflt;
    if (typeof v === 'number') return isFinite(v) ? v : (dflt || 0);
    const t = String(v).trim().replace(/[，,]/g, '');
    if (t === '') return dflt === undefined ? 0 : dflt;
    const f = parseFloat(t);
    return isFinite(f) ? f : (dflt === undefined ? 0 : dflt);
  };
  const floorTo = (v, step) => Math.floor(Math.abs(v) / step + 1e-9);

  // 盘口数值 → 中文名
  // ⚠ 入参 v 的单位是「分」（净分差），不是「球」：内部会先 FLOOR(v/HCP_STEP)×HCP_UNIT 折成球。
  //   要显示一个「球」单位的盘口（比如伤停量化算出来的 ball），请用 lineTextOfBall()，
  //   否则会放大一倍（0.25 球显示成「半球」）。
  function plateText(v, P, LIB) {
    const n = floorTo(v, P.HCP_STEP);
    if (Math.abs(v) < 1e-9 || n === 0) return '平手';
    const target = Math.min(n * P.HCP_UNIT, P.HCP_CAP);
    let name = String(round(target, 4));
    for (const [val, txt] of LIB.plate) { if (Math.abs(val - target) < 1e-6) { name = txt; break; } }
    return (v > 0 ? '主让' : '客让') + name;
  }
  /**
   * 中文盘口 → 数值（单位：球）。
   * ★ v15 修正：符号与新全站约定一致 —— **负数 = 主队让球**。
   *   旧版本写成「主让 → 正数」，与 evaluate/inputLine/settle/resolveUpper 的约定正好相反，
   *   导致「主让半球」被当成「客队让球」，上盘方和赛果全反。改完必须只走这一条路径。
   *   认不出来的写法返回 null（让调用方报错），不再猜。
   */
  function plateValue(text, P, LIB) {
    if (text === null || text === undefined) return null;
    const t = String(text).trim();
    if (!t) return null;
    if (t === '平手' || t === '0' || t === '0.0') return 0;
    if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);   // 纯数字照旧
    let s = 0;
    if (/^主队?受让/.test(t)) s = 1;                          // 主队受让 = 客队让球 → 正
    else if (/^客队?受让/.test(t)) s = -1;
    else if (/^受让/.test(t)) s = 1;
    else if (/^主队?让/.test(t)) s = -1;                      // 主队让球 → 负
    else if (/^客队?让/.test(t)) s = 1;                       // 客队让球 → 正
    const rest = t.replace(/^(主队受让|客队受让|主受让|客受让|主队让|客队让|主受|客受|主让|客让|受让)/, '').trim();
    let abs = null;
    for (const [val, txt] of LIB.plate) { if (txt === rest) { abs = val; break; } }
    if (abs === null) {
      const f = parseFloat(rest);
      abs = isFinite(f) ? Math.abs(f) : null;
    }
    if (abs === null) return null;
    if (s === 0) return null;    // 没写「谁让谁」→ 不猜，交给调用方提示
    return s * abs;
  }
  /**
   * 数值盘口（单位：球）→ 中文。**与引擎同约定**：负数 = 主队让球。
   * 用在「机构初盘 / 机构终盘」的显示与核对上，方便一眼看出符号填反没有。
   */
  function lineTextOfBall(v, P, LIB) {
    if (v === null || v === undefined || v === '') return '';
    const x = num(v, null);
    if (x === null || !isFinite(x)) return '';
    if (Math.abs(x) < 1e-9) return '平手';
    const target = Math.min(Math.abs(x), num(P.HCP_CAP, 3));
    let name = String(round(target, 4));
    for (const [val, txt] of LIB.plate) { if (Math.abs(val - target) < 1e-6) { name = txt; break; } }
    return (x < 0 ? '主让' : '客让') + name;
  }
  function tierOf(rank, P) {
    const r = num(rank, 0);
    if (!r) return '中游';
    if (r > P.RANK_TIER_MAX) return '下游';
    if (r <= P.RANK_TIER_LO) return '上游';
    if (r <= P.RANK_TIER_HI) return '中游';
    return '下游';
  }

  /* ---------------- 6. 内核：攻防积分 ---------------- */
  function attackDefense(side, inp, P, LIB) {
    const lg = LIB.leagues[inp.league] || { N: 20, coef: 1, R: 38 };
    const N = num(lg.N, 20), coef = num(lg.coef, 1);
    const g = [], c = [], o = [];
    for (let i = 6; i >= 1; i--) {
      g.push(num(inp[side + 'G' + i], null));
      c.push(num(inp[side + 'C' + i], null));
      o.push(num(inp[side + 'O' + i], null));
    }
    const adjG = [], adjC = [];
    for (let i = 0; i < 6; i++) {
      const gi = g[i] === null ? 0 : g[i], ci = c[i] === null ? 0 : c[i];
      const big = (gi - ci) >= num(P.AD_BIGWIN_DIFF, 3);
      adjG.push(big ? gi * num(P.AD_BIGWIN_FACTOR, 0.8) : gi);
      adjC.push(big ? ci * num(P.AD_BIGWIN_FACTOR, 0.8) : ci);
    }
    // 「近 6 场实际场次」：与「主队主场场次」是两个不同字段 —— 前者供攻防积分场均计算，后者供主战绩系数。
    // 未提供时退回“近 6 场里非空槽位的数量”。
    let games = inp[side + 'ADGames'];
    games = (games === '' || games === null || games === undefined) ? null : num(games, null);
    if (games === null) games = g.filter((x) => x !== null).length;
    const tg = adjG.reduce((a, b) => a + b, 0), tc = adjC.reduce((a, b) => a + b, 0);
    const avgG = games ? tg / games : 0, avgC = games ? tc / games : 0;
    const D = avgG - avgC;
    const vo = o.filter((x) => x !== null && x !== 0);
    const avgO = vo.length ? vo.reduce((a, b) => a + b, 0) / vo.length : 0;
    const sRatio = num(P.STRONG_OPP_RATIO, 1 / 3), wRatio = num(P.WEAK_OPP_RATIO, 2 / 3);
    const oppMul = (N === 0 || avgO === 0) ? 1
      : (avgO <= N * sRatio ? num(P.STRONG_OPP_MUL, 1.1)
        : (avgO >= N * wRatio ? num(P.WEAK_OPP_MUL, 0.85) : 1));
    const weaken = games ? Math.min(1, games / num(P.SAMPLE_FULL_GAMES, 6)) : 0;
    const cap = num(P.AD_CAP, 0.8);
    const digits = num(P.AD_BIGWIN_ROUND, 4);
    const med = clampMed(-cap, D * oppMul * num(P.AD_DFW, 0.35), cap);
    const score = round(med * coef * weaken, digits);
    return {
      score, D, adjG, adjC, tg, tc, avgG, avgC, oppMul, weaken, coef, games, avgO, N,
      strong: avgO && avgO <= N * sRatio, weak: avgO && avgO >= N * wRatio,
    };
  }

  /* ---------------- 7. 内核：主战绩系数偏差 ---------------- */
  function formScore(inp, P, LIB) {
    P = P || store.P; LIB = LIB || store.LIB;
    const lg = LIB.leagues[inp.league] || { N: 20, coef: 1, R: 38 };
    const dh = num(inp.hGames, 0), Eh = num(inp.hPts, 0);
    const da = num(inp.aGames, 0), Ea = num(inp.aPts, 0);
    const ppgH = dh ? Eh / dh : 0, ppgA = da ? Ea / da : 0;
    const K = ppgA ? ppgH / ppgA : 0;
    const base = num(P.FORM_A, 0.65) + K * num(P.FORM_B, 0.2);
    const lim = clampMed(num(P.FORM_LO, 0.7), base, num(P.FORM_HI, 1.3));
    const sm = dh < num(P.FORM_SMOOTH, 5) ? 1 + (lim - 1) * dh / num(P.FORM_SMOOTH, 5) : lim;
    const rem = num(lg.R, 38) - num(inp.round, 0);
    const isLate = num(inp.round, 0) > 0 && rem < num(P.FORM_LATE_ROUNDS, 5);
    const lt = isLate ? 1 + (sm - 1) * num(P.FORM_CONVERGE, 0.6) : sm;
    const isEmpty = truthy(inp.empty);
    const fin = isEmpty ? num(P.FORM_EMPTY, 0.5) : lt;
    const diff = round(fin * num(P.FORM_STEP, 0.125), 6);
    return { diff, coef: fin, K, ppgH, ppgA, base, lim, smooth: sm, late: lt, isLate, isEmpty };
  }

  /* ---------------- 8. 内核：排名分差 ---------------- */
  function rankScore(inp, P, LIB) {
    P = P || store.P; LIB = LIB || store.LIB;
    const lg = LIB.leagues[inp.league] || { N: 20, coef: 1, R: 38 };
    const N = num(lg.N, 20);
    const hr = num(inp.hRank, 0), ar = num(inp.aRank, 0);
    const ht = inp.hTier || tierOf(hr, P), at = inp.aTier || tierOf(ar, P);
    let dec = 1;
    for (const d of LIB.decay) { if (d.h === ht && d.a === at) { dec = num(d.v, 1); break; } }
    const rankRaw = N > 1 ? ((ar - hr) / (N - 1)) * num(P.RANK_W, 0.6) * dec : 0;
    const val = clampMed(num(P.RANK_LO, -0.5), rankRaw, num(P.RANK_HI, 0.5));
    return { diff: val, raw: rankRaw, rawClamped: val, decay: dec, hTier: ht, aTier: at, N };
  }

  /* ---------------- 9. 内核：加减分项 ---------------- */
  function adjustScore(inp, P, LIB, isLate) {
    P = P || store.P; LIB = LIB || store.LIB;
    const need = (t, d) => (t === '' || t === null || t === undefined) ? d : num(t, d);
    const lookup = (tbl, key, dflt) => (key in tbl ? num(tbl[key], 0) : (dflt === undefined ? 0 : dflt));

    const hHist = lookup(LIB.hist, inp.hHist);
    const hDep = lookup(LIB.depth, inp.hDepth, 1);
    const hInjRaw = lookup(LIB.injury, inp.hInjury) * hDep;
    const hInj = clampMed(-num(P.ADJ_CAP, 0.6), hInjRaw, 0);
    const hSus = lookup(LIB.suspend, inp.hSuspend);
    const hFat = lookup(LIB.fatigue, inp.hFatigue);
    const hStreak = lookup(LIB.streak, inp.hStreak);
    const hMot = isLate ? lookup(LIB.motive, inp.hMotive) : 0;
    const hTotal = hHist + Math.min(hInj, hSus) + hFat + hStreak + hMot;

    /* ★ v15 业务约定（用户拍板）：**客队历史交锋恒等于 0，填什么都等于 0。**
     *   下面这行照样查表，但只是为了把「你填了什么」原样存进记录、显示给你看，
     *   **绝不参与 aTotal 的计算**。不要「顺手」把它加进 aTotal —— 那会让
     *   全部历史记录的结论一起变。自检里有断言钉死这一点。 */
    const aHist = lookup(LIB.hist, inp.aHist);
    const aDep = lookup(LIB.depth, inp.aDepth, 1);
    const aInjRaw = lookup(LIB.injury, inp.aInjury) * aDep;
    const aInj = clampMed(-num(P.ADJ_CAP, 0.6), aInjRaw, 0);
    const aSus = lookup(LIB.suspend, inp.aSuspend);
    const aFat = lookup(LIB.fatigue, inp.aFatigue);
    const aStreak = lookup(LIB.streak, inp.aStreak);
    const aMot = isLate ? lookup(LIB.motive, inp.aMotive) * num(P.ADJ_MOTIV_AWAY, 0.5) : 0;
    // 客队总贡献 = MIN(伤病, 停赛) + 疲劳 + 连赢连负 + 战意   ←★ 没有历史交锋项，恒不含 +aHist
    const aTotal = Math.min(aInj, aSus) + aFat + aStreak + aMot;

    return {
      hTotal, aTotal, net: hTotal - aTotal, abs: Math.abs(hTotal - aTotal),
      h: { hist: hHist, inj: hInj, dep: hDep, sus: hSus, fat: hFat, streak: hStreak, motive: hMot },
      a: { hist: aHist, histIgnored: true, inj: aInj, dep: aDep, sus: aSus, fat: aFat, streak: aStreak, motive: aMot },
    };
  }

  /* ---------------- 10. 内核：场景 / 仲裁 / 评分 ---------------- */
  /**
   * 盘口方向比较 —— 必须用绝对值比，不能看有符号差值。
   *   Excel: ABS(K)>ABS(J) → 升盘；ABS(K)<ABS(J) → 降盘；相等 → 盘口不变
   * 注意：J、K 都可能变号（主让↔客让），有符号差值在跨零时会判反，
   *       例如 J=-0.5 → K=0.25：有符号差是 +0.75（像升盘），但 |0.25| < |0.5|，实际是降盘。
   */
  const HCP_EPS = 1e-9;
  function hcpMove(J, K) {
    // ★ v15：缺值不再当 0 参与比较（否则「终盘没填」会被判成「降盘」）
    if (J === null || J === undefined || J === '' || K === null || K === undefined || K === '') {
      return { up: false, down: false, same: false, unknown: true, d: 0, aJ: null, aK: null };
    }
    const aJ = Math.abs(num(J, 0)), aK = Math.abs(num(K, 0));
    const d = aK - aJ;
    return { up: d > HCP_EPS, down: d < -HCP_EPS, same: Math.abs(d) <= HCP_EPS, d: d, aJ: aJ, aK: aK, unknown: false };
  }
  /**
   * 深开 / 浅开 —— 心盘 vs 机构初盘：
   *   IF(I=0, IF(J=0,"平手","深开"),
   *      IF(I*(J-I)>0,"深开", IF(I*(J-I)<0,"浅开","平手")))
   * 与旧版的差别：心盘 I=0 时不再一律「平手」—— 心盘平手但机构开出让球，算「深开」。
   */
  function depthLabel(I, J) {
    if (I === 0) return (J === 0 || J === null) ? LABELS.flat : LABELS.deepHigh;
    const t = I * (J - I);
    return t > 0 ? LABELS.deepHigh : (t < 0 ? LABELS.shallow : LABELS.flat);
  }
  /**
   * 八大场景 —— 深开/浅开 × 水档 × 升降盘：
   *   深开/浅开 × 水档（高水|超高水 / 低水|超低水 / 中水） × 升盘降盘（ABS(K) vs ABS(J)）
   *   v12 起「深开/浅开 + 中水」不再落中性盘，而是拆成 4 个中水场景（m1~m4）
   *   盘口不变 × 水档 → 盘口不变·高/低/中水
   *   其余 → 「平手或错误」（v12 前叫「中性盘」）
   */
  function sceneOf(心盘I, J, K, O, P, LIB) {
    const S = LABELS.scene;
    /* ★ v15：盘口缺值 → 场景无从判定。
     *   旧写法把 null 当 0，于是「初盘没填」被判成「升盘」、「终盘没填」被判成「降盘」，
     *   凭空产出一个看起来很正常、实际是猜出来的场景。 */
    if (J === null || J === undefined || J === '') {
      return { Q: '无法判定', R: S.neutral, O: O || '未知', isHigh: false, isLow: false, isMid: false, mv: hcpMove(null, K), why: '没填机构初盘' };
    }
    if (K === null || K === undefined || K === '') {
      return { Q: '无法判定', R: S.neutral, O: O || '未知', isHigh: false, isLow: false, isMid: false, mv: hcpMove(J, null), why: '没填机构终盘' };
    }
    const j = (J === null ? 0 : J), k = (K === null ? 0 : K);
    const hi = (O === '高水' || O === '超高水');
    const lo = (O === '低水' || O === '超低水');
    const mi = (O === '中水');
    const mv = hcpMove(j, k);
    const q = depthLabel(心盘I, j);
    const deep = (q === LABELS.deepHigh), shallow = (q === LABELS.shallow);
    let r = S.neutral;
    if (deep && hi && mv.up) r = S.s1;
    else if (deep && hi && mv.down) r = S.s2;
    else if (deep && lo && mv.up) r = S.s3;
    else if (deep && lo && mv.down) r = S.s4;
    else if (shallow && hi && mv.up) r = S.s5;
    else if (shallow && hi && mv.down) r = S.s6;
    else if (shallow && lo && mv.up) r = S.s7;
    else if (shallow && lo && mv.down) r = S.s8;
    else if (deep && mi && mv.up) r = S.m1;       // v12
    else if (deep && mi && mv.down) r = S.m2;     // v12
    else if (shallow && mi && mv.up) r = S.m3;    // v12
    else if (shallow && mi && mv.down) r = S.m4;  // v12
    else if (mv.same && hi) r = S.fh;
    else if (mv.same && lo) r = S.fl;
    else if (mv.same && mi) r = S.fm;
    return { Q: q, R: r, O, isHigh: hi, isLow: lo, isMid: mi, mv: mv };
  }
  /** 是不是「中水四场景」之一（中水二次判定只对这 4 个生效） */
  function isMidScene(scene) {
    const S = LABELS.scene;
    return scene === S.m1 || scene === S.m2 || scene === S.m3 || scene === S.m4;
  }
  /* ---------------- 11. 主入口：单场完整计算 ---------------- */
  /**
   * inp: {
   *   league, round, home, away, hGames,aGames, hPts,aPts, empty,
   *   hRank,aRank, hTier,aTier(可空自动推),
   *   hG6..hG1,hC6..hC1,hO6..hO1, aG6..aG1,aC6..aC1,aO6..aO1,
   *   hHist,hInjury,hDepth,hSuspend,hFatigue,hStreak,hMotive,
   *   aHist,aInjury,aDepth,aSuspend,aFatigue,aStreak,aMotive,
   *   open, close, openWater, closeWater, openTime, closeTime,
   *   scoreText:'2:1', actual: '赢盘'|'输盘'|'走水' (可空自动判)
   * }
   */
  function evaluate(inp, P, LIB) {
    P = P || store.P; LIB = LIB || store.LIB;
    const lg = LIB.leagues[inp.league] || { N: 20, coef: 1, R: 38 };
    const H = attackDefense('h', inp, P, LIB);
    const A = attackDefense('a', inp, P, LIB);
    const adDiff = round(H.score - A.score, 8);
    const F = formScore(inp, P, LIB);
    const R = rankScore(inp, P, LIB);
    const ADJ = adjustScore(inp, P, LIB, F.isLate);

    // 各方向
    const dirAD = sgn(adDiff), dirForm = sgn(F.diff), dirRank = sgn(R.diff), dirAdj = sgn(ADJ.net);
    const consensus = [dirAD, dirForm, dirRank, dirAdj].filter((d) => d > 0).length;

    // 主队总分 / 客队总分（与「盘」表 E/F 一致）
    const E = F.diff + H.score + R.diff + ADJ.hTotal;
    const Ft = A.score + 0 + ADJ.aTotal;
    const G = E - Ft;
    const I = Math.min(floorTo(G, num(P.HCP_STEP, 0.125)) * num(P.HCP_UNIT, 0.25), num(P.HCP_CAP, 3)) * (G > 0 ? -1 : 1);

    /* ---- 机构盘口（★ 负数 = 主队让球；正数 = 客队让球）---- */
    const J = inputLine(inp.open, P, LIB);          // 机构初盘
    const hasOpen = !(inp.open === '' || inp.open === null || inp.open === undefined);
    const closeGiven = !(inp.close === '' || inp.close === null || inp.close === undefined);
    let K = inputLine(inp.close, P, LIB);           // 机构终盘
    /* ★ v15：终盘留空 = 盘口没变动（表单里本来就是这么写的），不再当成 0 球。
     *   旧写法把 null 当 0 参与 hcpMove，于是「终盘没填」会被判成「降盘」，凭空造出场景。 */
    if (!closeGiven && J !== null) K = J;

    const numOrNull = function (v) {
      if (v === '' || v === null || v === undefined) return null;
      const x = num(v, NaN);
      return isFinite(x) ? x : null;
    };
    const Lw = numOrNull(inp.openWater), Mw = numOrNull(inp.closeWater);
    const Nv = (K === null || J === null) ? 0 : K - J;
    const O = waterLevel(Lw, P);
    const Pp = moveLevel(Math.abs(Nv), P);
    const MV = hcpMove(J, K);
    const SC = sceneOf(I, J, K, O, P, LIB);

    /* ---- 数据完整性警告（★ v15：缺数据要明说，不许静默编一个出来）---- */
    const warn = [];
    if (!hasOpen || J === null) {
      warn.push({ k: 'open', t: '没填「机构初盘」，或写法认不出来 —— 深开/浅开、八大场景、仲裁、偏差评分都无法判定' });
    }
    if (!closeGiven && J !== null) {
      warn.push({ k: 'close', t: '终盘留空，已按「与初盘相同」处理（= 盘口不变）' });
    }
    if (Lw === null) {
      warn.push({ k: 'openWater', t: '没填「初盘水位」—— 水档判成「未知」，八大场景无法判定。请补水位，或在「机构让球方」里手动点一下' });
    }
    if (Mw === null) {
      warn.push({ k: 'closeWater', t: '没填「终盘水位」—— 联动评分按「中性」处理（不加分也不扣分）' });
    }
    if (!(inp.league && (inp.league in LIB.leagues))) {
      warn.push({ k: 'league', t: '联赛「' + (inp.league || '空') + '」不在联赛映射表里，已按默认（20 队 / 系数 1.00 / 38 轮）处理，联赛系数会不准' });
    }

    // 仲裁（v14：默认新口径「方向对称」；LIB.arbMode='legacy' 可切回旧口径对照）
    const rawFour = { adDiff, formDiff: F.diff, rankDiff: R.diff, adjNet: ADJ.net };
    const arbNew = arbitrate(J, rawFour, P, LIB);
    const arbOld = arbitrateLegacy(J, rawFour, dirAdj, P);
    const useLegacy = (LIB && LIB.arbMode === 'legacy');
    const arbInfo = useLegacy ? arbOld : arbNew;
    const arb = arbInfo.label;

    // 评分四件套
    const dJ = (J === null) ? 0 : J;
    const dev = Math.abs(dJ - I);
    const Z = dev <= num(P.DEV_T1, 0.25) ? 1 : dev <= num(P.DEV_T2, 0.5) ? 2 : dev >= num(P.DEV_T3, 0.75) ? 3 : 2;
    let AA;
    // 联动评分：升盘 / 降盘一律用 |终盘| vs |初盘| 判（不能用有符号差，会跨 0 判反）
    // ★ v15：水位缺一个就按「中性」处理（null 参与 < 比较会被当成 0，误判成「升盘低水」）
    if (Lw === null || Mw === null || MV.unknown) AA = num(P.LINK_MID, 1);
    else if (MV.up && Mw < Lw) AA = num(P.LINK_HI, 3);
    else if (MV.down && Mw > Lw) AA = num(P.LINK_HI, 3);
    else if (MV.up && Mw > Lw) AA = num(P.LINK_LO, 0);
    else if (MV.down && Mw < Lw) AA = num(P.LINK_LO, 0);
    else AA = num(P.LINK_MID, 1);
    const AB = num(arbInfo.score, 0);   // 仲裁评分：跟着所选口径走
    let AC = num(P.TIME_DEF, 1);
    if (inp.openTime && inp.closeTime) {
      const d = hoursBetween(inp.openTime, inp.closeTime);
      if (d !== null) AC = d >= 24 ? num(P.TIME_T4, 2) : d >= 6 ? num(P.TIME_T3, 1.5) : d >= 3 ? num(P.TIME_T2, 1) : num(P.TIME_T1, 0.5);
    }
    const total = round(Z + AA + AB + AC, 4);
    const strength = total >= num(P.STRONG_SCORE, 7) ? LABELS.strength.s : total >= num(P.MED_SCORE, 4) ? LABELS.strength.m : LABELS.strength.w;
    /* ---- 上盘方（机构让球方）：自动判定 + 手动指定覆盖 ----
     * ★ v15 新增 inp.upSideManual：平手盘、或水位记法摸不准时，由人点一下定音。 */
    const U0auto = resolveUpper(J, K, Lw, Mw, P, LIB);
    const MAN = String(inp.upSideManual === null || inp.upSideManual === undefined ? '' : inp.upSideManual).trim();
    let U0 = U0auto;
    if (MAN === '主队' || MAN === '客队') {
      U0 = {
        side: MAN === '主队' ? -1 : 1, upSide: MAN, from: 'manual',
        note: '**手动指定**：本场机构让球方 = ' + MAN +
          '（自动判定原本是「' + U0auto.upSide + '」，依据：' + upperFromLabel(U0auto.from) + '）',
      };
      if (U0auto.upSide !== '平手' && U0auto.upSide !== MAN) {
        warn.push({ k: 'upSideManual', t: '手动指定上盘方为「' + MAN + '」，但按盘口数值的正负号推出来是「' + U0auto.upSide + '」—— 先确认盘口有没有填反（负数 = 主队让球）' });
      }
    } else if (MAN === '平手') {
      U0 = { side: 0, upSide: '平手', from: 'manual', note: '**手动指定**：本场不设上盘（按走水处理）' };
    }
    const side = U0.side;                    // -1 主队上盘；+1 客队上盘；0 平手
    const upSide = U0.upSide;

    /* 中水二次判定（v15：以「基本面四项占优方向」为唯一基准）
     * ⚠ 必须把 upSide / J 一起传进来 —— 旧写法传了个残缺对象，导致它一律把自己当「客队上盘」，
     *   主队让球的中水场次全判反，表格那列和推荐方向自相矛盾。 */
    const MVerd = midVerdict({
      scene: SC.R, arb: arb, arbKey: arbInfo.key, devScore: Z,
      consensus: consensus, upSide: upSide, side: side, J: J,
    });
    const crit = Math.abs(G - Math.round(G / num(P.HCP_STEP, 0.125)) * num(P.HCP_STEP, 0.125)) < 0.001;
    let actual = inp.actual || '';
    let goalDiff = null;
    if (inp.scoreText) {
      const m = String(inp.scoreText).replace('：', ':').match(/(-?\d+)\s*:\s*(-?\d+)/);
      if (m) {
        goalDiff = parseInt(m[1], 10) - parseInt(m[2], 10);
        if (!actual) actual = settle(upSide, J === null ? 0 : J, goalDiff);
      }
    }
    return {
      inp, H, A, adDiff, F, R, ADJ,
      E: E, F2: Ft, net: round(G, 8),
      netRaw: G,
      corePan: I, corePanText: plateText(G, P, LIB), crit,
      J, K, Lw, Mw, Nv, water: O, move: Pp,
      jText: lineTextOfBall(J, P, LIB), kText: lineTextOfBall(K, P, LIB),
      warn: warn, upSideManual: MAN, upAuto: U0auto.upSide,
      Q: SC.Q, scene: SC.R, arb, consensus,
      arbKey: arbInfo.key, arbPass: arbInfo.pass, arbTone: arbInfo.tone, arbStatus: arbInfo.status,
      arbWhy: arbInfo.why, arbL: arbNew.L, arbS: arbNew.S, arbE1: arbNew.e1, arbE2: arbNew.e2,
      arbNew: arbNew, arbOld: arbOld, arbMode: useLegacy ? 'legacy' : 'v2',
      absJ: MV.aJ, absK: MV.aK, hcpUp: MV.up, hcpDown: MV.down, hcpSame: MV.same,
      isMidScene: isMidScene(SC.R),
      midVerdict: MVerd.text, midVerdictObj: MVerd, midTone: MVerd.tone, midDir: MVerd.dir,
      devScore: Z, linkScore: AA, arbScore: AB, timeScore: AC, total, strength,
      upSide, goalDiff, actual, upFrom: U0.from, upNote: U0.note || '',
      raw: { adDiff, formDiff: F.diff, rankDiff: R.diff, adjNet: ADJ.net },
    };
  }

  /**
   * 水位分档。★ v15：没填水位返回「未知」，不再把「没填」当成 0 判成「超低水」。
   *   「未知」不匹配任何水档 → sceneOf 落「平手或错误」，并在 evaluate 里写进 warn 列表。
   */
  function waterLevel(l, P) {
    if (l === null || l === undefined || l === '') return '未知';
    const v = num(l, NaN);
    if (!isFinite(v)) return '未知';
    if (v <= num(P.W_ULTRA_LOW, 0.8)) return '超低水';
    if (v <= num(P.W_LOW, 0.9)) return '低水';
    if (v <= num(P.W_MID, 0.99)) return '中水';
    if (v <= num(P.W_HIGH, 1.09)) return '高水';
    return '超高水';
  }
  function moveLevel(absNv, P) {
    if (absNv <= num(P.MOVE_SMALL, 0.25)) return '微调';
    if (absNv <= num(P.MOVE_MID, 0.5)) return '中幅';
    if (absNv >= num(P.MOVE_BIG, 0.75)) return '大幅';
    return '—';
  }
  /**
   * 机构盘口文字 → 数值。
   * ★ 符号约定（全站统一）：负数 = 主队让球，「主让半球」→ −0.5；正数 = 客队让球。
   */
  function inputLine(v, P, LIB) {
    if (v === '' || v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    const t = String(v).trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    const pv = plateValue(t, P, LIB);
    return pv;
  }
  /**
   * 赛果自动判定 —— ★ v14.1 修正盘口符号
   * 约定：J < 0 = 主队让球（主队上盘）；J > 0 = 客队让球。
   * 所以「主队上盘」赢盘的条件是 goalDiff > |J|，不是 goalDiff > −|J|。
   * 旧写法用的是「受让」逻辑（+hcp），在让球盘上把输盘判成赢盘。
   * 用 12 场示例比赛验证：修正后 12/12 命中（修正前 8/12）。
   * 平手盘（J=0）没有让球方 → 谁赢球谁赢盘，打平走水（由下面的 upSide 决定归属）。
   */
  function settle(upSide, J, goalDiff) {
    if (upSide === '平手') return '走水';
    const hcp = Math.abs(J);
    const v = upSide === '主队' ? goalDiff - hcp : -goalDiff - hcp;
    return v > 0 ? '赢盘' : v < 0 ? '输盘' : '走水';
  }
  function hoursBetween(a, b) {
    const ta = toDate(a), tb = toDate(b);
    if (!ta || !tb) return null;
    return (tb - ta) / 36e5;
  }
  function toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(v);
    if (!v) return null;
    let s = String(v).trim().replace('T', ' ');
    const d = new Date(s.replace(/\//g, '-').replace(/-/g, '/'));
    return isNaN(d.getTime()) ? null : d;
  }
  function truthy(v) {
    if (typeof v === 'boolean') return v;
    const s = String(v == null ? '' : v).trim().toUpperCase();
    return s === 'TRUE' || s === '是' || s === '1' || s === '空场';
  }

  /* ---------------- 11b. 统计工具（Wilson / 分组胜率） ---------------- */
  const Z95 = 1.959964;
  /** Wilson 得分区间：小样本也能看出「是不是真优势」 */
  function wilson(w, n, z) {
    z = z || Z95;
    if (!n) return { p: 0, lo: 0, hi: 0 };
    const p = w / n, d = 1 + z * z / n;
    const c = p + z * z / (2 * n);
    const r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return { p: p, lo: Math.max(0, (c - r) / d), hi: Math.min(1, (c + r) / d) };
  }
  function pct(v, n) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return (v * 100).toFixed(n === undefined ? 1 : n) + '%';
  }
  function decidedX(x) { return x.r.actual === '赢盘' || x.r.actual === '输盘'; }
  function wonX(x) { return x.r.actual === '赢盘'; }
  /**
   * 按维度汇总历史胜率。返回 { overall, scene, q, arb, strength, depth, water, move, league, upSide }
   * 每项 = { n, dn, w, rate, lo, hi }（dn = 已开奖场次）
   */
  function groupRates(recs, P, LIB) {
    recs = recs || store.rows;
    P = P || store.P; LIB = LIB || store.LIB;
    const all = recs.map(function (rec) { return { rec: rec, r: evaluate(rec.inp, P, LIB) }; });
    const build = function (f) {
      const map = {};
      all.forEach(function (x) {
        const k = String(f(x));
        (map[k] = map[k] || []).push(x);
      });
      const out = {};
      Object.keys(map).forEach(function (k) {
        const arr = map[k], d = arr.filter(decidedX);
        const w = d.filter(wonX).length;
        const ci = wilson(w, d.length);
        out[k] = { n: arr.length, dn: d.length, w: w, rate: d.length ? w / d.length : null, lo: ci.lo, hi: ci.hi };
      });
      return out;
    };
    // 方向层的统计（按场景方向买的历史命中率）
    const dAll = all.filter(decidedX), wAll = dAll.filter(wonX).length;
    const ciAll = wilson(wAll, dAll.length);
    return {
      overall: { n: all.length, dn: dAll.length, w: wAll, rate: dAll.length ? wAll / dAll.length : null, lo: ciAll.lo, hi: ciAll.hi },
      scene: build(function (x) { return x.r.scene; }),
      q: build(function (x) { return x.r.Q; }),
      arb: build(function (x) { return x.r.arb; }),
      strength: build(function (x) { return x.r.strength; }),
      depth: build(function (x) { return x.r.consensus + '/4'; }),
      water: build(function (x) { return x.r.water; }),
      move: build(function (x) { return x.r.move; }),
      league: build(function (x) { return x.rec.inp.league || '未知'; }),
      upSide: build(function (x) { return x.r.upSide; }),
      side: sideRates(recs, P, LIB),
    };
  }

  /* ---------------- 11d. 场景方向指向（买上盘还是买下盘） ---------------- */
  /** '场景5：浅开高水升盘诱上' → '场景5'；'中水·深升·待验证' → 原值；其它 → 原值 */
  function sceneKeyOf(scene) {
    const m = String(scene || '').match(/^(场景\d)/);
    return m ? m[1] : String(scene || '');
  }
  /**
   * 场景名本身就在告诉你要买哪一边：
   *   阻上 / 强支 / 补防 / 诱下 → 跟上盘
   *   诱上 / 看衰            → 跟下盘（机构在引诱你买上盘）
   *   v12 中水四场景（中水·…）→ 'cond'，方向由「中水二次判定」按一致数量 X 决定
   * 优先读 LIB.sceneDir（可在「调参中心 → 映射表」改），缺项时按场景名关键词兜底。
   */
  function sceneSide(scene, LIB) {
    LIB = LIB || store.LIB;
    const raw = String(scene || '');
    const key = sceneKeyOf(raw);
    const dir0 = (LIB.sceneDir || {})[key];
    let dir = dir0, fromLib = dir0 !== undefined;
    if (dir === undefined || dir === null) {
      // 关键词兜底
      dir = 'none';
      const kw = LIB.sceneKw || {};
      Object.keys(kw).forEach(function (k) { if (raw.indexOf(k) >= 0) dir = kw[k]; });
      fromLib = false;
    }
    let word = '';
    const kwAll = ['阻上', '强支', '补防', '诱下', '诱上', '看衰'];
    kwAll.forEach(function (k) { if (raw.indexOf(k) >= 0 && word === '') word = k; });
    if (dir === 'cond' && isMidScene(raw)) {
      // 中水场景：光看名字不够，要等 X（一致数量）出来才知道往哪边
      const tail = raw.replace('中水·', '');
      word = tail;
      dir = 'cond';
    }

    const why = dir === 'up'
      ? '场景名含「' + (word || '支持上盘') + '」—— 机构在' +
        (word === '阻上' ? '阻止资金买上盘（怕上盘）' : word === '强支' ? '明确强力支持上盘' :
          word === '补防' ? '给上盘补防守' : word === '诱下' ? '引诱大家去买下盘' : '支持上盘') +
        '，跟上盘。'
      : dir === 'down'
        ? '场景名含「' + (word || '看衰上盘') + '」—— 机构在' +
          (word === '诱上' ? '引诱资金买上盘（上盘是陷阱）' : word === '看衰' ? '看衰上盘' : '保护下盘') +
          '，<b>反着买下盘</b>。'
        : dir === 'cond'
          ? '中水场景「' + (word || raw) + '」—— 中水本身信号很弱，还要看「中水二次判定」（一致数量 X + 偏差评分 Z）才能定方向。'
          : '场景名不含方向词（' + (raw || '—') + '），机构没有给出明确指向，本场不做方向判断。';

    return {
      key: key, raw: raw, dir: dir, word: word, why: why, fromLib: fromLib,
      side: dir === 'up' ? '上盘' : dir === 'down' ? '下盘' : '不选',
      label: dir === 'up' ? '跟上盘' : dir === 'down' ? '反买下盘' : dir === 'cond' ? '看二次判定' : '无指向',
    };
  }
  /**
   * 结合「上盘是谁」+（中水场景时）「中水二次判定」得出到底买哪支球队。
   * r 是 evaluate() 的结果（r.upSide = '主队' / '客队' / '平手'）
   */
  function sideOf(r, LIB) {
    const ss = sceneSide(r.scene, LIB);
    const up = r.upSide;
    let dir = ss.dir, why = ss.why, cond = null;
    if (dir === 'cond') {
      cond = midVerdict(r);
      dir = cond.dir || 'none';
      why = cond.text + '（' + ss.why + '）';
    }
    /* ★ v14.1 平手盘（初盘与终盘都是 0 球）：场景名给不了方向，
     *   改用「水位低的一方是上盘」推出上盘，然后跟上盘（让球为 0 时水位就是盘口）。
     *   两侧都是中水 → upSide='平手' → 仍然不参与。 */
    let flatFrom = false;
    if (dir === 'none' && (r.upFrom === 'water' || r.upFrom === 'default') && up !== '平手' &&
      (!LIB || LIB.flatWaterDir !== 'ignore')) {
      dir = 'up'; flatFrom = true;
      why = (r.upNote || '平手盘靠水位判出上盘') +
        '<br>让球为 0 时，机构只能用<b>水位</b>表达强弱 —— 水位低的一方是热门（上盘）。既然场景给不出方向，就跟着水位走。';
    }
    let team = '—';
    if (dir === 'up') team = up;
    else if (dir === 'down') team = up === '主队' ? '客队' : up === '客队' ? '主队' : '平手';
    const side = dir === 'up' ? '上盘' : dir === 'down' ? '下盘' : '不选';
    return {
      scene: ss, dir: dir, side: side, team: team,
      upSide: up, cond: cond, flatFrom: flatFrom,
      text: dir === 'none' ? '不参与（' + (ss.dir === 'cond' ? '中水二次判定不成立' : '场景无指向') + '）' : '买 ' + team + '（' + side + '）',
      why: why,
    };
  }

  /**
   * 「按场景方向买」的历史命中率（只统计已开奖）。
   *   正向场景 → 上盘赢盘算命中；反向场景 → 下盘赢盘（即上盘输盘）算命中
   *   中水场景只有在「中水二次判定」给出方向时才计入
   * 返回 { overall, byScene }
   */
  function sideRates(recs, P, LIB) {
    recs = recs || store.rows;
    P = P || store.P; LIB = LIB || store.LIB;
    const all = recs.map(function (rec) { return { rec: rec, r: evaluate(rec.inp, P, LIB) }; });
    const dirOf = function (x) { return sideOf(x.r, LIB).dir; };
    const hit = function (x) {
      const d = dirOf(x);
      if (d !== 'up' && d !== 'down') return null;
      if (x.r.actual !== '赢盘' && x.r.actual !== '输盘') return null;
      const upWin = x.r.actual === '赢盘';
      return d === 'up' ? upWin : !upWin;
    };
    const build = function (arr) {
      const dn = arr.filter(function (x) { return hit(x) !== null; });
      const w = dn.filter(function (x) { return hit(x) === true; }).length;
      const ci = wilson(w, dn.length);
      return { n: arr.length, dn: dn.length, w: w, rate: dn.length ? w / dn.length : null, lo: ci.lo, hi: ci.hi };
    };
    const byScene = {};
    all.forEach(function (x) {
      const k = sceneSide(x.r.scene, LIB).key;
      (byScene[k] = byScene[k] || []).push(x);
    });
    const out = {};
    Object.keys(byScene).forEach(function (k) { out[k] = build(byScene[k]); });
    return { overall: build(all), byScene: out };
  }

  /* ---------------- 11e. 模型置信度（每一场、基于场景） ---------------- */
  /** 指标名：跟着迭代版本号走（v12 → 模型置信度 v12） */
  function confName(P) {
    P = P || store.P;
    return '模型置信度 v' + num(P.ITERATION, 12);
  }
  /**
   * 小样本收缩后的 Wilson 下界。
   * 把 w/dn 按「先验样本量 k、先验胜率 p0」往中间拉，避免 1胜0负 → 100%。
   */
  function shrunkLo(w, dn, P) {
    const k = num(P.CONF_PRIOR_N, 4), p0 = num(P.CONF_PRIOR_P, 0.5);
    const W = w + k * p0, N = dn + k;
    return wilson(W, N).lo;
  }
  /**
   * 模型置信度（0~100）：这个「基于场景」的判断到底有多可信。
   *   ① 场景证据  同场景按方向买的历史（收缩后的 Wilson 下界）
   *   ② 方向证据  四票一致数量（强背离归零、信号无效打折）
   *   ③ 场景清晰度 标准 8 场景 / 中水 / 盘口不变 / 平手或错误，再按偏差评分缩放
   *   ④ 盘口结构  联动评分 + 时间评分 + 变动幅度
   * 再套用封顶：强背离 / 平手或错误 / 中水不判定；心盘临界打折。
   * agg = groupRates() 的结果（需要 agg.side）
   */
  function confidence(r, agg, P) {
    P = P || store.P;
    agg = agg || {};
    const sd = sideOf(r, P && store.LIB);
    const ss = sceneSide(r.scene, store.LIB);
    const kind = /^场景\d/.test(r.scene) ? 'scene'
      : isMidScene(r.scene) ? 'mid'
        : (r.scene === LABELS.scene.fh || r.scene === LABELS.scene.fl || r.scene === LABELS.scene.fm) ? 'flat'
          : 'none';

    /* ① 场景证据 */
    const W1 = num(P.CONF_W_SCENE, 45);
    const byScene = ((agg.side || {}).byScene || {})[ss.key] || { dn: 0, w: 0 };
    const lo = shrunkLo(byScene.w || 0, byScene.dn || 0, P);
    const f = clamp01((lo - num(P.CONF_LO_FLOOR, 0.25)) / Math.max(1e-6, num(P.CONF_LO_CEIL, 0.55) - num(P.CONF_LO_FLOOR, 0.25)));
    const p1 = f * W1;

    /* ② 方向证据 —— ★ v14：改成「相对下注方向」的方向对称口径
     * 旧写法是 (consensus/4)*W2，那是纯主队视角：客队上盘且模型正确认出客队更强（X=0/1）时只有 0~6 分，
     * 方向是反的。现在改成看「长期实力 + 短期突发」是否支持**要买的那一边**。 */
    const W2 = num(P.CONF_W_DIR, 25);
    const betTeam = sd.dir === 'up' ? r.upSide : (sd.dir === 'down' ? (r.upSide === '主队' ? '客队' : '主队') : null);
    const sgnBet = betTeam === '主队' ? 1 : (betTeam === '客队' ? -1 : 0);
    const rv = r.raw || {};
    const Lv = num(rv.adDiff, 0) + num(rv.formDiff, 0) + num(rv.rankDiff, 0);
    const Sv = num(rv.adjNet, 0);
    const eL = sgnBet ? sgn(Lv) * sgnBet : 0;    // +1 = 长期支持下注方
    const eS = sgnBet ? sgn(Sv) * sgnBet : 0;    // +1 = 短期支持下注方
    let dirSupport;
    if (sd.dir === 'none' || !sgnBet) dirSupport = 0.5;   // 没方向 → 中性
    else if (eL > 0 && eS > 0) dirSupport = 1;            // 长期+短期都支持
    else if (eL > 0 && eS < 0 && Math.abs(Sv) >= num(P.VETO_ABS, 0.3)) dirSupport = 0.2;  // 短期明显反向
    else if (eL > 0 && eS < 0) dirSupport = 0.8;          // 短期小分歧
    else if (eL < 0 && eS < 0) dirSupport = 0.05;         // 全面背离
    else if (eL < 0 && eS > 0) dirSupport = 0.5;          // 长期背离但短期支持
    else dirSupport = 0.5;
    let dirMul = 1;
    if (arbIsVeto(r)) dirMul = 0;
    else if (arbIsBad(r)) dirMul = 0.6;
    const p2 = dirSupport * W2 * dirMul;

    /* ③ 场景清晰度 */
    const W3 = num(P.CONF_W_CLARITY, 15);
    const kindMul = kind === 'scene' ? 1 : kind === 'mid' ? 0.6 : kind === 'flat' ? 0.33 : 0;
    const devMul = r.devScore >= 3 ? 1 : r.devScore === 2 ? 0.85 : 0.6;
    const p3 = W3 * kindMul * devMul;

    /* ④ 盘口结构 */
    const W4 = num(P.CONF_W_STRUCT, 15);
    const linkPart = r.linkScore >= 3 ? 0.4 : r.linkScore >= 1 ? 0.27 : 0.07;
    const timePart = r.timeScore >= 2 ? 0.33 : r.timeScore >= 1.5 ? 0.27 : r.timeScore >= 1 ? 0.17 : 0.07;
    const movePart = r.move === '大幅' ? 0.27 : r.move === '中幅' ? 0.2 : 0.1;
    const p4 = W4 * (linkPart + timePart + movePart) / 0.99;

    /* 封顶与折扣 */
    let raw = p1 + p2 + p3 + p4;
    const caps = [];
    if (arbIsVeto(r)) caps.push({ k: '一票否决（机构与模型全面背离）', v: num(P.CONF_CAP_VETO, 25) });
    if (kind === 'none') caps.push({ k: '平手或错误（场景未匹配）', v: num(P.CONF_CAP_NEUTRAL, 30) });
    if (kind === 'mid' && sd.dir === 'none') caps.push({ k: '中水但二次判定不成立', v: num(P.CONF_CAP_MIDWATER, 55) });
    caps.forEach(function (c) { if (raw > c.v) raw = c.v; });
    if (r.crit) raw *= num(P.CONF_CRIT_MUL, 0.9);
    const score = Math.max(0, Math.min(100, Math.round(raw * 10) / 10));

    /* 分档 */
    const T1 = num(P.CONF_T1, 80), T2 = num(P.CONF_T2, 65), T3 = num(P.CONF_T3, 50), T4 = num(P.CONF_T4, 35);
    let band, tone, advice;
    if (score >= T1) { band = '高置信'; tone = 'ok'; advice = '证据完整，可正常出手'; }
    else if (score >= T2) { band = '中高'; tone = 'ok'; advice = '可以出手，但建议控制仓位'; }
    else if (score >= T3) { band = '中等'; tone = 'warn'; advice = '小注或观望，等临场信息'; }
    else if (score >= T4) { band = '偏弱'; tone = 'warn'; advice = '建议观望'; }
    else { band = '低置信'; tone = 'bad'; advice = '放弃'; }

    const flags = [];
    if (byScene.dn < num(P.CONF_PRIOR_N, 4)) flags.push('同场景样本少（' + (byScene.dn || 0) + ' 场），已按先验收缩');
    if (r.crit) flags.push('心盘正好在盘口分界线上');
    if (kind === 'mid') flags.push('中水场景：' + (r.midVerdict || '—'));
    if (arbIsBad(r)) flags.push('短期反向：方向证据已打 6 折');

    return {
      name: confName(P), v: num(P.ITERATION, 12), score: score, band: band, tone: tone, advice: advice,
      dir: sd.dir, side: sd.side, team: sd.team, sceneKind: kind,
      parts: [
        { n: '① 场景证据', v: round(p1, 1), max: W1, why: '同场景按方向买 ' + (byScene.dn ? (byScene.w + '/' + byScene.dn) : '无样本') + '，收缩后 Wilson 下界 ' + pct(lo) },
        { n: '② 方向证据', v: round(p2, 1), max: W2, why: sd.dir === 'none' ? '本场没有下注方向，取中性 50%' :
          ('下注方 = ' + betTeam + '；' + (eL > 0 ? '长期支持' : eL < 0 ? '长期反对' : '长期持平') + '、' +
           (eS > 0 ? '短期支持' : eS < 0 ? '短期反对' : '短期持平') + '　|　仲裁「' + r.arb + '」') },
        { n: '③ 场景清晰度', v: round(p3, 1), max: W3, why: (kind === 'scene' ? '标准 8 场景' : kind === 'mid' ? '中水场景' : kind === 'flat' ? '盘口不变' : '平手或错误') + '，偏差评分 ' + r.devScore },
        { n: '④ 盘口结构', v: round(p4, 1), max: W4, why: '联动 ' + r.linkScore + ' / 时间 ' + r.timeScore + ' / 变动 ' + r.move },
      ],
      caps: caps, flags: flags, lo: lo, sample: { w: byScene.w || 0, dn: byScene.dn || 0 },
    };
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  /**
   * 置信度校准表：把记录库按置信度分档，看每档的**实际**投注盈利概率。
   * 这是检验「模型置信度到底说没说真话」的唯一办法。
   */
  function confCalibration(recs, P, LIB) {
    recs = recs || store.rows;
    P = P || store.P; LIB = LIB || store.LIB;
    const agg = groupRates(recs, P, LIB);
    const rows = recs.map(function (rec) {
      const r = evaluate(rec.inp, P, LIB);
      const c = confidence(r, agg, P);
      const d = sideOf(r, LIB).dir;
      let win = null;
      if ((d === 'up' || d === 'down') && (r.actual === '赢盘' || r.actual === '输盘')) {
        const upWin = r.actual === '赢盘';
        win = (d === 'up') ? upWin : !upWin;
      }
      const w = num(rec.inp.closeWater !== '' && rec.inp.closeWater !== undefined ? rec.inp.closeWater : rec.inp.openWater, 0.95);
      const water = d === 'down' ? Math.max(0.5, Math.round((num(P.WATER_SUM, 2) - w) * 100) / 100) : w;
      const profit = win === null ? null : (win ? (water - 1) : -1);
      return { rec: rec, r: r, conf: c, dir: d, win: win, water: water, profit: profit };
    });
    const T = [num(P.CONF_T1, 80), num(P.CONF_T2, 65), num(P.CONF_T3, 50), num(P.CONF_T4, 35)];
    const bands = [
      { n: '高置信 ≥' + T[0], lo: T[0], hi: Infinity },
      { n: '中高 ' + T[1] + '~' + T[0], lo: T[1], hi: T[0] },
      { n: '中等 ' + T[2] + '~' + T[1], lo: T[2], hi: T[1] },
      { n: '偏弱 ' + T[3] + '~' + T[2], lo: T[3], hi: T[2] },
      { n: '低置信 <' + T[3], lo: -Infinity, hi: T[3] },
    ];
    const out = bands.map(function (b) {
      const arr = rows.filter(function (x) { return x.conf.score >= b.lo && x.conf.score < b.hi; });
      const dec = arr.filter(function (x) { return x.win !== null; });
      const w = dec.filter(function (x) { return x.win; }).length;
      const roi = dec.length ? dec.reduce(function (a, x) { return a + x.profit; }, 0) / dec.length : null;
      const ci = wilson(w, dec.length);
      return {
        n: b.n, total: arr.length, dn: dec.length, w: w,
        rate: dec.length ? w / dec.length : null, roi: roi,
        lo: ci.lo, hi: ci.hi,
        avgConf: arr.length ? arr.reduce(function (a, x) { return a + x.conf.score; }, 0) / arr.length : null,
        rows: arr,
      };
    });
    return { rows: rows, bands: out, agg: agg };
  }

  /* ---------------- 11i. 伤停量化引擎（依据「本次优化规则」） ----------------
   *  目的：把「球衣号码 / 位置 / 身价 / 上轮阵容 / 本场伤停」自动换算成
   *        ① 伤病等级文本（给主表 C2/I2）② 阵容深度文本（D2/J2）③ 停赛等级文本（E2/K2）
   *  主表（加减分项）的架构与公式完全不动 —— 这里只生产文本标签，数值仍由 VLOOKUP 查表。
   * ------------------------------------------------------------------------- */

  /** 位置命名对照：以「球员信息表」里的位置名为准（uploaded 表格实际用词） */
  const POS_CLASS_DEF = {
    '守门员': 'GK',
    '中卫': 'CB', '后卫': 'CB',                 // 表里「后卫」是没细分的中卫
    '左后卫': 'FB', '右后卫': 'FB',
    '后腰': 'DM',
    '中前卫': 'CM', '中场': 'CM',               // 表里「中场」是泛称
    '前腰': 'AM',
    '左边锋': 'WM', '右边锋': 'WM', '左中场': 'WM', '右中场': 'WM',
    '中锋': 'ST', '前锋': 'ST', '影锋': 'ST',    // 表里「前锋/影锋」归中锋档
  };
  /** 位置伤害修正系数（规则原表 GK/CB/WB/CM/WM/ST 六档；后腰、前腰规则没单列，由我补） */
  const POS_FAC_DEF = {
    GK: 1.20,   // 规则原值：门将不可替代，替补门将水平断崖
    CB: 1.10,   // 规则原值
    FB: 1.00,   // 规则原值（WB 边后卫）
    DM: 1.08,   // ★ 规则没列。后腰是防线前屏障，稀缺度介于 CB 与 CM 之间
    CM: 1.05,   // 规则原值
    AM: 1.02,   // ★ 规则没列。前腰创造力核心，但防守贡献低、现代足球可被边锋替代
    WM: 0.95,   // 规则原值
    ST: 0.95,   // 规则原值
  };
  /* ---------------- 11c2. 仲裁（v14 重新设计：方向对称） ----------------
   * 旧口径的四票 S/T/U/V 全是「主队 − 客队」，所以方向语义是【主队/客队】；
   * 但模型的决策方向是【上盘/下盘】（场景名「阻上 / 诱上」说的就是上盘）。
   * 两者只在「主队 = 上盘」时重合 —— 客队让球（客让盘）时整个仲裁语义是反的。
   * 而且四票与心盘、心盘与机构盘高度同源，所以「信号有效」几乎等价于「主队是热门」，没有增量信息。
   *
   * 新口径：**以机构让球方（上盘方）为基准**做方向对称检验
   *   L = 攻防 + 主战绩 + 排名     长期固有实力
   *   S = 加减                     短期突发（伤停 / 停赛 / 疲劳 / 战意）—— 唯一可能与机构开盘脱节的信息
   *   sgnUp = +1 表示机构让球方是主队（J<0）
   *   e1 = sgn(L) × sgnUp   → +1 = 长期实力支持机构让球方
   *   e2 = sgn(S) × sgnUp   → +1 = 短期突发支持机构让球方
   */
  const ARB_BRANCH = {
    resonance: { tone: 'ok', pass: true, status: 'valid' },
    minorSplit: { tone: 'ok', pass: true, status: 'valid' },
    longDivergence: { tone: 'warn', pass: true, status: 'caution' },
    majorReversal: { tone: 'bad', pass: false, status: 'invalid' },
    totalDivergence: { tone: 'veto', pass: false, status: 'veto' },
    thin: { tone: 'mute', pass: true, status: 'thin' },
  };
  function arbFmt(v) { return (v >= 0 ? '+' : '') + (Math.round(v * 10000) / 10000); }
  function arbitrate(J, raw, P, LIB) {
    P = P || store.P;
    const L = num(raw.adDiff, 0) + num(raw.formDiff, 0) + num(raw.rankDiff, 0);
    const S = num(raw.adjNet, 0);
    const mag = Math.abs(S);
    const sgnL = sgn(L), sgnS = sgn(S);
    const sgnUp = (J === null || J === undefined) ? 0 : (J < 0 ? 1 : J > 0 ? -1 : 0);
    const upSide = sgnUp > 0 ? '主队' : sgnUp < 0 ? '客队' : '平手';
    const e1 = (sgnL === 0 || sgnUp === 0) ? 0 : sgnL * sgnUp;
    const e2 = (sgnS === 0 || sgnUp === 0) ? 0 : sgnS * sgnUp;
    const vetoAbs = num(P.VETO_ABS, 0.3);
    const SC = {
      resonance: num(P.ARB_OK, 2), minorSplit: num(P.ARB_MINOR, 1.5),
      longDivergence: num(P.ARB_DIV, 1), majorReversal: num(P.ARB_REV, 0.5),
      totalDivergence: num(P.ARB_TOTAL, 0), thin: num(P.ARB_THIN, 1),
    };
    const other = upSide === '主队' ? '客队' : '主队';
    let key, why;
    if (sgnUp === 0) {
      key = 'thin';
      why = '机构开平手盘，没有让球方 —— 仲裁问的「机构让球方是否被基本面支持」没有主语。';
    } else if (e1 > 0 && e2 > 0) {
      key = 'resonance';
      why = '机构让 ' + upSide + ' 球，长期实力（攻防+主战绩+排名 = ' + arbFmt(L) + '）与短期突发（加减 = ' +
        arbFmt(S) + '）都指向' + upSide + ' —— 三方同向。';
    } else if (e1 > 0 && e2 < 0 && mag >= vetoAbs) {
      key = 'majorReversal';
      why = '机构让 ' + upSide + ' 球，长期实力也支持' + upSide + '（' + arbFmt(L) + '），' +
        '但短期突发明显反向（加减 = ' + arbFmt(S) + '，|S| ≥ ' + vetoAbs + '，约折 ' +
        Math.min(Math.floor(mag / num(P.HCP_STEP, 0.125)) * num(P.HCP_UNIT, 0.25), num(P.HCP_CAP, 3)) +
        ' 球）—— 机构可能没跟上这批伤停/突发信息，让球方向有风险。';
    } else if (e1 > 0 && e2 < 0) {
      key = 'minorSplit';
      why = '机构让 ' + upSide + ' 球，长期实力支持' + upSide + '（' + arbFmt(L) + '），' +
        '短期只有小幅反向（加减 = ' + arbFmt(S) + '，|S| < ' + vetoAbs + '）—— 影响不到半个盘口。';
    } else if (e1 < 0 && e2 > 0) {
      key = 'longDivergence';
      why = '⚠ 机构让 ' + upSide + ' 球，但模型算出的长期实力指向' + other + '（长期三项合计 ' + arbFmt(L) + '）；' +
        '短期突发却支持' + upSide + '（' + arbFmt(S) + '）—— 机构可能是基于短期信息开的盘。';
    } else if (e1 < 0 && e2 < 0) {
      key = 'totalDivergence';
      why = '❌ 机构让 ' + upSide + ' 球，但长期实力（' + arbFmt(L) + '）与短期突发（' + arbFmt(S) + '）' +
        '全部指向' + other + ' —— 机构开盘方向与模型完全相反，最典型的诱盘结构。';
    } else {
      key = 'thin';
      why = '长期三项合计只有 ' + arbFmt(L) + '，方向不明显 —— 证据不足，不做方向判断。';
    }
    const br = ARB_BRANCH[key];
    return {
      key: key, label: LABELS.arb[key], tone: br.tone, pass: br.pass, status: br.status,
      score: SC[key], why: why, upSide: upSide,
      L: L, S: S, e1: e1, e2: e2, mag: mag, vetoAbs: vetoAbs,
    };
  }
  /** 旧口径仲裁（纯主队视角），保留以便对照 */
  function arbitrateLegacy(J, raw, dirAdj, P) {
    P = P || store.P;
    let arb = LABELS.arb.bad;
    if (dirAdj !== 1 && Math.abs(num(raw.adjNet, 0)) >= num(P.VETO_ABS, 0.3)) arb = LABELS.arb.veto;
    else if ((sgn(num(raw.adDiff, 0)) > 0 ? 1 : 0) + (sgn(num(raw.formDiff, 0)) > 0 ? 1 : 0) +
      (sgn(num(raw.rankDiff, 0)) > 0 ? 1 : 0) >= num(P.CONSENSUS_MIN, 2)) arb = LABELS.arb.ok;
    const score = arb === LABELS.arb.ok ? num(P.ARB_OK, 2)
      : (arb === LABELS.arb.veto ? num(P.ARB_VETO, 0.5) : num(P.ARB_BAD, 0));
    return { key: arb === LABELS.arb.ok ? 'ok' : (arb === LABELS.arb.veto ? 'veto' : 'bad'), label: arb, score: score, pass: arb === LABELS.arb.ok };
  }
  /* ---- 语义化判定：v14 起 r.arb 的取值跟着「仲裁口径」走，别再比字符串 ---- */
  function arbIsVeto(r) { return r.arbKey === 'totalDivergence' || r.arb === LABELS.arb.veto; }
  function arbIsBad(r) { return r.arbKey === 'majorReversal' || r.arb === LABELS.arb.bad; }
  function arbIsOk(r) { return r.arbKey === 'resonance' || r.arb === LABELS.arb.ok; }
  function arbIsCaution(r) { return r.arbKey === 'longDivergence'; }

  const POS_CLASS_NAME = { GK: '门将', CB: '中后卫', FB: '边后卫', DM: '后腰', CM: '中前卫', AM: '前腰', WM: '边前卫/边锋', ST: '中锋' };

  /** 身价文本 → 万欧元数值。"4500万欧元" → 4500；"-" / "" → null */
  function parseValue(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    const s = String(raw).trim();
    if (!s || s === '-' || s === '—') return null;
    let m = /^([\d.]+)\s*万欧元$/.exec(s);
    if (m) return Math.round(parseFloat(m[1]));
    m = /^([\d.]+)\s*亿欧元$/.exec(s);
    if (m) return Math.round(parseFloat(m[1]) * 10000);
    m = /^([\d.]+)\s*万$/.exec(s);
    if (m) return Math.round(parseFloat(m[1]));
    m = /^([\d.,]+)$/.exec(s);
    if (m) return Math.round(parseFloat(m[1].replace(/,/g, '')));
    return null;
  }
  function posClass(pos, LIB) {
    const map = (LIB && LIB.posClass) || POS_CLASS_DEF;
    const key = String(pos || '').trim();
    if (map[key]) return map[key];
    // 兜底：按关键字猜
    if (/门将|守门/.test(key)) return 'GK';
    if (/后卫|中卫|边卫/.test(key)) return 'CB';
    if (/后腰|防守中场/.test(key)) return 'DM';
    if (/中场|前卫/.test(key)) return 'CM';
    if (/前腰|组织/.test(key)) return 'AM';
    if (/锋|前锋|边锋/.test(key)) return 'ST';
    return 'CM';
  }
  function posFacOf(pos, P, LIB) {
    const fac = (LIB && LIB.posFac) || POS_FAC_DEF;
    const c = posClass(pos, LIB);
    return num(fac[c], POS_FAC_DEF[c] !== undefined ? POS_FAC_DEF[c] : 1.0);
  }

  /**
   * 伤停量化主函数。
   * @param players  [{num, name, pos, val}]  —— 全队球员（val 单位：万欧元，可为 null）
   * @param ctx      {injured:[号码], suspended:[号码], starters:[号码], subs:[号码],
   *                  subsMode:'bench'|'played', newSign:[号码], subW: 可选覆盖}
   * @param P 参数, LIB 映射表
   * @returns {ok, pool, valSum, poolDropped, loss, residual, injured:[明细], suspended:[明细],
   *           injuryLabel, depthLabel, suspendLabel, gkDown, notes:[...]}
   */
  function computeInjury(players, ctx, P, LIB) {
    P = P || store.P; LIB = LIB || store.LIB;
    players = (players || []).filter(function (p) { return p && p.pos !== '主教练'; });
    ctx = ctx || {};
    const toSet = function (a) {
      const s = {};
      (a || []).forEach(function (x) { const n = parseInt(String(x).trim(), 10); if (isFinite(n)) s[n] = true; });
      return s;
    };
    const sInj0 = toSet(ctx.injured), sSus0 = toSet(ctx.suspended);
    const sSta = toSet(ctx.starters), sSub = toSet(ctx.subs), sNew = toSet(ctx.newSign);
    const notes = [];

    /* ---- 步骤 1：有效阵容池 ValidPool ---- */
    const vals = players.map(function (p) { return num(p.val, null); })
      .filter(function (v) { return v !== null && v > 0; }).sort(function (a, b) { return a - b; });
    const pctIdx = Math.floor(vals.length * num(P.EDGE_PCT, 0.10));
    const pctCut = vals.length ? vals[Math.min(pctIdx, vals.length - 1)] : -1;
    const isEdge = function (p) {
      const v = num(p.val, null);
      return num(p.num, 0) > num(P.EDGE_NUM, 40) && v !== null && v > 0 && v <= pctCut;
    };
    let pool = players.slice();
    const dropped = [];
    players.forEach(function (p) { if (isEdge(p)) dropped.push(p); });
    const removed = [];
    // 保护 1：剔除后人数 < POOL_MIN → 按身价从低到高放回
    const minN = num(P.POOL_MIN, 18);
    if (pool.length - dropped.length < minN) {
      const back = dropped.slice().sort(function (a, b) { return num(a.val, 0) - num(b.val, 0); });
      let need = minN - (pool.length - dropped.length);
      const push = [];
      for (let i = 0; i < back.length && need > 0; i++) { push.push(back[i]); need--; }
      pool = pool.filter(function (p) { return push.indexOf(p) < 0; });
      dropped.forEach(function (p) { if (push.indexOf(p) < 0) removed.push(p); });
      notes.push('有效池人数不足 ' + minN + '，已放回 ' + push.length + ' 名边缘球员（保护规则 1）');
    } else {
      pool = pool.filter(function (p) { return dropped.indexOf(p) < 0; });
      dropped.forEach(function (p) { removed.push(p); });
    }
    // 保护 2：门将保护 —— 池内门将 ≤ GK_KEEP 就强制保留
    const gkKeep = num(P.GK_KEEP, 2);
    const gkOut = dropped.filter(function (p) { return posClass(p.pos, LIB) === 'GK' && pool.indexOf(p) < 0; });
    let gkInPool = pool.filter(function (p) { return posClass(p.pos, LIB) === 'GK'; }).length;
    gkOut.forEach(function (p) {
      if (gkInPool < gkKeep) {
        pool.push(p); gkInPool++;
        const ri = removed.indexOf(p); if (ri >= 0) removed.splice(ri, 1);
        notes.push('门将保护：把 ' + (p.name || ('#' + p.num)) + ' 放回有效池（保护规则 2）');
      }
    });
    const valSum = pool.reduce(function (a, p) { return a + num(p.val, 0); }, 0);
    const avgVal = pool.length ? valSum / pool.length : 0;

    /* ---- 步骤 2：W_i / PosFac / S_i ----
     * ★ 本场伤停名单（伤病 + 停赛合一）里每个号码后面可以标 (是)/(否)，
     *   表示他上一场到底有没有上场。有标注以标注为准，没标注按 ①首发 / ②替补 自动推断。
     *   优先级：标注 > 新援 > 上一场首发 > 上一场替补 > 没进大名单
     */
    const W = {
      start: num(P.W_START, 1.00), subPlayed: num(P.W_SUB_PLAYED, 0.45),
      bench: num(P.W_BENCH, 0.15), out: num(P.W_OUT, 0.02), newSign: num(P.W_NEW, 0.60),
    };
    const byNum = {};
    players.forEach(function (p) { const n = parseInt(p.num, 10); if (isFinite(n) && !byNum[n]) byNum[n] = p; });
    const byName = {};
    players.forEach(function (p) { if (p.name) byName[String(p.name).trim()] = p; });

    // 把带标注的名单统一成「号码 → {played, suspend, isNew}」
    const injMarks = markMap(ctx.injured, byName);
    const susMarks = markMap(ctx.suspended, byName);
    const subMarks = markMap(ctx.subs, byName);   // ★ ②上一场替补里标 (是) = 替补登场
    const staMarks = markMap(ctx.starters, byName);
    const allMarks = {};
    Object.keys(injMarks).forEach(function (k) { allMarks[k] = injMarks[k]; });
    Object.keys(susMarks).forEach(function (k) {
      const c = allMarks[k] = allMarks[k] || { played: null, suspend: false, isNew: false, unknown: [] };
      c.suspend = true;
      if (susMarks[k].played !== null) c.played = susMarks[k].played;
    });
    // 标注里写了「停」的，自动并进停赛名单
    const markedSuspend = {};
    Object.keys(allMarks).forEach(function (k) { if (allMarks[k].suspend) markedSuspend[k] = true; });
    // 本场伤病 = 本场伤病名单 + 标注里带「停」的（但停赛人员不算伤病，下面会剔掉）
    const injSet = {};
    Object.keys(injMarks).forEach(function (k) { injSet[k] = true; });
    Object.keys(markedSuspend).forEach(function (k) { if (!sSus0[k]) injSet[k] = true; });
    // 停赛名单 = 显式停赛 + 标注里写「停」的
    const susSet = {};
    Object.keys(sSus0).forEach(function (k) { susSet[k] = true; });
    Object.keys(markedSuspend).forEach(function (k) { susSet[k] = true; });
    // 一个人不可能同时伤病+停赛 → 停赛优先，并从伤病里剔除并提醒
    const both = Object.keys(injSet).filter(function (k) { return susSet[k]; });
    if (both.length) {
      notes.push('这些号码同时出现在伤病与停赛里（不可能同时发生，已按「停赛」处理，从伤病损失中剔除）：' +
        both.map(function (n) { return '#' + n + (byNum[n] ? ' ' + byNum[n].name : ''); }).join('、'));
      both.forEach(function (k) { delete injSet[k]; });
    }
    // 标注里写了但没识别出来的词
    const unknownMarks = [];
    Object.keys(allMarks).forEach(function (k) {
      (allMarks[k].unknown || []).forEach(function (u) { unknownMarks.push('#' + k + '(' + u + ')'); });
    });
    if (unknownMarks.length) notes.push('这些标注没看懂，已按「未标注」处理：' + unknownMarks.join('、'));

    const wOf = function (p) {
      const n = parseInt(p.num, 10);
      const mk = allMarks[n] || null;
      // ① 显式标注：上一场有没有上场
      if (mk && mk.played === true) {
        if (sSta[n]) return { w: W.start, why: '标注「上一场有上场」+ 在①首发名单 → 首发' };
        if (sSub[n]) return { w: W.subPlayed, why: '标注「上一场有上场」+ 在②替补名单 → 替补登场' };
        return { w: W.subPlayed, why: '标注「上一场有上场」（未列首发/替补，按替补登场计）' };
      }
      if (mk && mk.played === false) {
        if (sSub[n]) return { w: W.bench, why: '标注「上一场没上场」+ 在②替补名单 → 坐板凳' };
        return { w: W.out, why: '标注「上一场没上场」（且不在大名单）' };
      }
      // ② 没标注 → 自动推断
      if (mk && mk.isNew) return { w: W.newSign, why: '标注「新援」' };
      if (sNew[n]) return { w: W.newSign, why: '新援（本队没有上一轮出场记录）' };
      if (sSta[n]) return { w: W.start, why: '上一场首发' };
      if (sSub[n]) {
        // ★ ②里逐个标注「替补有没有登场」：标 (是) → 0.45；(否) 或未标注 → 0.15
        const sm = subMarks[n];
        if (sm && sm.played === true) return { w: W.subPlayed, why: '②替补名单里标了「是」→ 替补登场' };
        if (sm && sm.played === false) return { w: W.bench, why: '②替补名单里标了「否」→ 坐板凳' };
        return ctx.subsMode === 'played'
          ? { w: W.subPlayed, why: '②替补名单未标注（按「有上场」默认）' }
          : { w: W.bench, why: '②替补名单未标注 → 默认坐板凳' };
      }
      return { w: W.out, why: '上一场没有进入大名单' };
    };

    // 号码查不到 → 允许按姓名查（AI 识别不准时手动填姓名）
    const resolve = function (tok) {
      const s = String(tok).trim();
      if (!s) return null;
      const o = parseRosterList(s)[0];
      const head = o ? o.tok : s;
      if (/^\d+$/.test(head)) {
        const n = parseInt(head, 10);
        if (byNum[n]) return byNum[n];
      }
      if (byName[head]) return byName[head];
      const n2 = parseInt(head, 10);
      if (isFinite(n2) && byNum[n2]) return byNum[n2];
      return null;
    };

    const detail = [];
    let sumDamaged = 0, loss = 0;
    const injKeys = Object.keys(injSet);
    const injList = injKeys.map(function (n) { return byNum[n]; }).filter(Boolean);
    const miss = injKeys.filter(function (n) { return !byNum[n]; });
    // 也允许直接写姓名（不在号码表里但在花名册里）
    const extraInj = (ctx.injured || []).map(function (t) {
      const o = parseRosterList(String(t))[0];
      if (!o || o.num !== null) return null;
      return (!injList.length || !injList.some(function (p) { return p.name === o.tok; })) &&
        byName[o.tok] && injList.indexOf(byName[o.tok]) < 0 ? byName[o.tok] : null;
    }).filter(Boolean);
    extraInj.forEach(function (p) { if (injList.indexOf(p) < 0) injList.push(p); });
    if (miss.length) notes.push('伤病名单里这些号码在本队花名册中找不到：' + miss.join('、'));
    injList.forEach(function (p) {
      const w = wOf(p);
      const v = num(p.val, null);
      const eff = (v === null || v <= 0) ? avgVal : v;   // 身价缺失 → 用队内平均兜底
      const s = valSum > 0 ? eff / valSum : 0;
      const pf = posFacOf(p.pos, P, LIB);
      const li = w.w * s * pf;
      loss += li;
      sumDamaged += w.w * eff * pf;
      detail.push({
        num: p.num, name: p.name, pos: p.pos, cls: posClass(p.pos, LIB), val: v === null ? eff : v,
        valMissing: v === null,
        w: w.w, why: w.why, s: s, posFac: pf, lossInd: li,
      });
    });
    detail.sort(function (a, b) { return b.lossInd - a.lossInd; });

    /* ---- 步骤 3：Loss_Est → 伤病文本标签 ---- */
    const T = [num(P.LOSS_T1, 0.04), num(P.LOSS_T2, 0.10), num(P.LOSS_T3, 0.18), num(P.LOSS_T4, 0.27), num(P.LOSS_T5, 0.35)];
    const LADDER = ['阵容齐整或无影响缺阵', '单名普通主力缺阵', '单名绝对核心缺阵',
      '双核或攻防双主力缺阵', '三核缺阵或半套主力', '大面积伤病潮'];
    let band;
    if (!injList.length) band = 0;
    else if (loss < T[0]) band = 0;
    else if (loss < T[1]) band = 1;
    else if (loss < T[2]) band = 2;
    else if (loss < T[3]) band = 3;
    else if (loss < T[4]) band = 4;
    else band = 5;
    const injuryLabel = LADDER[band];

    /* ---- 步骤 4：阵容深度文本标签（★ 已修正重复惩罚，见下方说明） ----
     * 规则原文：ResidualRatio = (ValidSumVal − Σ(W×Val×PosFac)) / ValidSumVal
     *          而 S_i = Val_i / ValidSumVal，所以 ResidualRatio ≡ 1 − Loss_Est
     *          ⇒ 伤病等级 与 阵容深度 是同一个数的两种分档，两个乘数同向叠加，
     *            等于对「缺人」这件事惩罚两次（违背规则自己写的「禁止重复惩罚」原则）。
     *
     * 修正：把「阵容深度」改成球队的**固有板凳厚度**，与伤病完全解耦 ——
     *      DepthRatio = 替补席平均身价 ÷ 首发平均身价（「替补能顶几成首发」）
     *      它只描述这支球队有没有牌可换，跟本场伤了几个人无关。
     *      板凳厚（≥ DEPTH_HI）→ ×0.7 削弱扣分；板凳薄（< DEPTH_LO）→ ×1.4 放大扣分。
     *      这正好回到规则文档自己的说法：「阵容深度系数仅仅是伤病项事后的缩放乘数」。
     *
     * LIB.depthMode = 'squad'（默认，修正版）| 'residual'（规则原文，保留可选）
     */
    const residual = valSum > 0 ? (valSum - sumDamaged) / valSum : 1;
    const poolVals = pool.map(function (p) { return num(p.val, 0); })
      .filter(function (v) { return v > 0; }).sort(function (a, b) { return b - a; });
    const xiN = Math.max(1, Math.min(num(P.DEPTH_XI, 11), Math.max(1, poolVals.length - 1)));
    let depthRatio = 0, avgStarter = 0, avgBench = 0;
    if (poolVals.length > xiN) {
      const top = poolVals.slice(0, xiN).reduce(function (a, b) { return a + b; }, 0);
      const rest = poolVals.slice(xiN).reduce(function (a, b) { return a + b; }, 0);
      avgStarter = top / xiN;
      avgBench = rest / (poolVals.length - xiN);
      depthRatio = avgStarter > 0 ? avgBench / avgStarter : 0;
    }
    const depthMode = (LIB.depthMode === 'residual') ? 'residual' : 'squad';
    let depthMetric, dHi, dLo;
    if (depthMode === 'residual') {
      depthMetric = residual;
      dHi = num(P.DEPTH_RES_HI, 0.88); dLo = num(P.DEPTH_RES_LO, 0.75);
    } else {
      depthMetric = depthRatio;
      dHi = num(P.DEPTH_HI, 0.28); dLo = num(P.DEPTH_LO, 0.19);
    }
    const DLADDER = ['深度雄厚', '深度一般', '深度薄弱'];
    let di;
    if (!injList.length && num(P.DEPTH_FORCE, 1) >= 1) {
      di = 1;
      notes.push('无伤病 → 强制输出「深度一般」（保护规则 1，避免凭空产生 0.7 红利）。' +
        '本队真实 DepthRatio = ' + depthRatio.toFixed(4) + '（要按真实档位输出就把 DEPTH_FORCE 改成 0）');
    } else if (depthMetric >= dHi) di = 0;
    else if (depthMetric >= dLo) di = 1;
    else di = 2;
    if (depthMode === 'residual' && injList.length) {
      notes.push('⚠ 当前深度口径是「规则原文（residual）」：它与伤病等级同源，' +
        '两个乘数会同向叠加、等于对缺人惩罚两次。建议切到「固有板凳厚度（squad）」。');
    }
    let gkDown = false;
    const gkAll = pool.filter(function (p) { return posClass(p.pos, LIB) === 'GK'; });
    // 「主力门将」优先取「上一场首发的门将」（那才是真正的主力），没有首发信息才退回身价最高的门将
    const gkStart = Object.keys(sSta).map(function (n) { return byNum[n]; })
      .filter(function (p) { return p && posClass(p.pos, LIB) === 'GK'; })[0];
    const gkRich = gkAll.slice().sort(function (a, b) { return num(b.val, 0) - num(a.val, 0); })[0];
    const gkKey = gkStart || gkRich;
    if (gkKey && injSet[parseInt(gkKey.num, 10)]) {
      if (di < 2) { di++; gkDown = true; notes.push('主力门将 ' + (gkKey.name || ('#' + gkKey.num)) + ' 在伤病名单 → 深度等级强制降一档'); }
      else { gkDown = true; notes.push('主力门将 ' + (gkKey.name || ('#' + gkKey.num)) + ' 在伤病名单（已是「深度薄弱」，保持不变）'); }
    }
    const depthLabel = DLADDER[di];

    /* ---- 步骤 5：停赛文本标签 ---- */
    const susDetail = [];
    const susKeys = Object.keys(susSet);
    susKeys.forEach(function (n) {
      const p = byNum[n];
      if (!p) { notes.push('停赛名单里的「#' + n + '」在花名册中找不到'); return; }
      const w = wOf(p);
      susDetail.push({
        num: p.num, name: p.name, pos: p.pos, w: w.w, why: w.why, main: w.w >= W.start - 1e-9,
        byMark: !!(ctx.suspended || []).map(function (t) { return parseRosterList(String(t))[0]; })
          .some(function (o) { return o && o.num === Number(n); }) ? false : true,
      });
    });
    // 也允许直接写姓名
    (ctx.suspended || []).forEach(function (t) {
      const o = parseRosterList(String(t))[0];
      if (!o || o.num !== null || !byName[o.tok]) return;
      const p = byName[o.tok];
      if (susDetail.some(function (x) { return x.num === p.num; })) return;
      const w = wOf(p);
      susDetail.push({ num: p.num, name: p.name, pos: p.pos, w: w.w, why: w.why, main: w.w >= W.start - 1e-9 });
    });
    let suspendLabel = '无停赛';
    if (susDetail.some(function (x) { return x.main; })) suspendLabel = '首发主力红牌停赛';
    else if (susDetail.length) suspendLabel = '轮换球员红牌停赛';
    // 停赛名单里给了号但花名册没有 → 也要给标签（否则会漏判）
    if (suspendLabel === '无停赛' && susKeys.length) {
      suspendLabel = '轮换球员红牌停赛';
      notes.push('停赛名单非空但有号码没匹配上，保守按「轮换球员红牌停赛」处理');
    }

    /* ---- 停赛名单（来自合并栏里的 (停) 标记，或单独的 suspended 输入） ---- */

    /* ---- 落到主表的分值（走加减库查表） ---- */
    const injScore = num((LIB.injury || {})[injuryLabel], 0);
    const depMul = num((LIB.depth || {})[depthLabel], 1.0);
    const susScore = num((LIB.suspend || {})[suspendLabel], 0);
    const injFinal = Math.min(0, Math.max(-0.6, injScore * depMul));   // MEDIAN(-0.6, 乘积, 0)

    return {
      ok: true, pool: pool, poolDropped: removed,
      poolKept: pool.filter(function (p) { return dropped.indexOf(p) >= 0; }),
      valSum: valSum, avgVal: avgVal, pctCut: pctCut,
      loss: loss, residual: residual, sumDamaged: sumDamaged,
      depthMode: depthMode, depthRatio: depthRatio, depthMetric: depthMetric,
      depthHi: dHi, depthLo: dLo, avgStarter: avgStarter, avgBench: avgBench, xiN: xiN,
      injured: detail, suspended: susDetail,
      markedPlayedYes: detail.filter(function (d) { return (allMarks[parseInt(d.num, 10)] || {}).played === true; }).length,
      markedPlayedNo: detail.filter(function (d) { return (allMarks[parseInt(d.num, 10)] || {}).played === false; }).length,
      injuryLabel: injuryLabel, depthLabel: depthLabel, suspendLabel: suspendLabel,
      gkDown: gkDown, gkName: gkKey ? (gkKey.name || ('#' + gkKey.num)) : null,
      injScore: injScore, depMul: depMul, susScore: susScore, injFinal: injFinal,
      finalContribution: Math.min(injFinal, susScore),
      notes: notes,
      band: band, residualBand: di,
    };
  }

  /** 号码/姓名列表 → 数组（支持 逗号/空格/顿号/换行/分号 混合） */
  function parseNumList(text) {
    return String(text || '').split(/[\s,，、;；|/]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s !== ''; });
  }

  /* ---------------- 带标注的名单解析（★ 本场伤停要在号码后面标「上一场有没有上」） ----------------
   * 支持的写法（空格/中英文括号都可以）：
   *   9            未标注
   *   9(是) 9（有）9(上场) 9(上了)       → 上一场有上场
   *   9(否) 9（没）9(没上) 9(板凳) 9(未上) → 上一场没上场
   *   9(停) 9(停赛) 9(红牌)              → 本场是停赛（不是伤病）
   *   9(新) 9(新援)                      → 新援
   *   9(是/停) 9(否,伤)                  → 可以用 / , + 、 组合多个
   *   凯恩(是)                           → 也可以直接写姓名
   * 返回 [{tok, num, name, played, suspend, isNew, raw}]
   *   played: true = 上一场有上场 / false = 没上场 / null = 没标注
   */
  const MARK_YES = /^(是|有|有上|上场|上了|上过|出|出场|首发|y|yes|true|1)$/i;
  const MARK_NO = /^(否|没|没有|没上|未|未上|未出场|板凳|替补席|坐板凳|n|no|false|0)$/i;
  const MARK_SUS = /^(停|停赛|红牌|红牌停赛|禁赛)$/;
  const MARK_NEW = /^(新|新援|转会|新签)$/;
  const MARK_INJ = /^(伤|伤病|伤停|受伤)$/;
  function parseRosterList(text) {
    // 先把「9 (是)」这种中间的空格去掉，让标注跟号码贴在一起
    const norm = String(text || '')
      .replace(/([^\s,，、;；|/（()）])\s+([（(])/g, '$1$2');
    const out = [];
    norm.split(/[\s,，、;；|]+/).forEach(function (rawTok) {
      const tok = rawTok.trim();
      if (!tok) return;
      let head = tok, mark = '';
      const m = /^([^（()）]*)[（(]([^）)]*)[）)]?/.exec(tok);
      if (m) { head = m[1]; mark = m[2] || ''; }
      // 也支持 9-是 / 9:是 这种写法
      if (!mark) {
        const m2 = /^([^\-:：]+)[\-:：](.+)$/.exec(tok);
        if (m2) { head = m2[1]; mark = m2[2]; }
      }
      head = head.trim();
      if (!head) return;
      const item = { tok: head, num: null, name: null, played: null, suspend: false, isNew: false, raw: tok };
      if (/^\d+$/.test(head)) item.num = parseInt(head, 10);
      else item.name = head;
      if (mark) {
        const parts = String(mark).split(/[\/,，、+＋|]/).map(function (s) { return s.trim(); }).filter(Boolean);
        parts.forEach(function (pt) {
          if (MARK_YES.test(pt)) item.played = true;
          else if (MARK_NO.test(pt)) item.played = false;
          else if (MARK_SUS.test(pt)) item.suspend = true;
          else if (MARK_NEW.test(pt)) item.isNew = true;
          else if (MARK_INJ.test(pt)) { /* 伤病，默认 */ }
          else if (/^(上|下)?\d+$/.test(pt)) { /* 忽略 */ }
        });
        // 只写了「是/否」之外的词、没识别出来 → 记下来给 UI 提示
        if (item.played === null && !item.suspend && !item.isNew &&
          !parts.some(function (pt) { return MARK_INJ.test(pt); })) {
          item.unknownMark = mark;
        }
      }
      out.push(item);
    });
    return out;
  }

  /** 标注列表 → 覆盖表：{号码: {played, suspend, isNew}}；按姓名给的也解析成号码 */
  function markMap(list, byName) {
    const mm = {};
    (list || []).forEach(function (it) {
      const o = (typeof it === 'string') ? parseRosterList(it)[0] : it;
      if (!o) return;
      let n = o.num;
      if (n === null && o.name && byName && byName[o.name]) n = parseInt(byName[o.name].num, 10);
      if (n === null || !isFinite(n)) return;
      const cur = mm[n] = mm[n] || { played: null, suspend: false, isNew: false, unknown: [] };
      if (o.played !== null) cur.played = o.played;
      if (o.suspend) cur.suspend = true;
      if (o.isNew) cur.isNew = true;
      if (o.unknownMark) cur.unknown.push(o.unknownMark);
    });
    return mm;
  }

  /**
   * ★ 一场比赛两个队一起算（同联赛主客队）
   * @param homeRoster / awayRoster  两队花名册
   * @param ctx {home:{...}, away:{...}}  各自的 computeInjury 上下文
   * @returns {home, away, net, ball, ballText, line, notes}
   *   net      = 主队最终伤停贡献 − 客队最终伤停贡献（对应加减分项 T3 里的伤停部分）
   *   ball     = 折算成盘口球数（每 0.125 分 = 0.25 球，封顶 3 球）
   */
  function computeMatch(homeRoster, awayRoster, ctx, P, LIB) {
    P = P || store.P; LIB = LIB || store.LIB;
    ctx = ctx || {};
    const h = computeInjury(homeRoster, ctx.home || {}, P, LIB);
    const a = computeInjury(awayRoster, ctx.away || {}, P, LIB);
    const net = h.finalContribution - a.finalContribution;
    const steps = Math.floor(Math.abs(net) / Math.max(1e-9, num(P.HCP_STEP, 0.125)));
    const ball = Math.min(steps * num(P.HCP_UNIT, 0.25), num(P.HCP_CAP, 3));
    const ballText = Math.abs(net) < 1e-9 ? '平手'
      // ★ v15 修正：ball 的单位是「球」，必须用 lineTextOfBall（旧写法走 plateText 会当成「分」→ 放大一倍）
      : (Math.abs(net) < num(P.HCP_STEP, 0.125) ? '平手' : lineTextOfBall(net > 0 ? -ball : ball, P, LIB));
    const notes = [];
    if (Math.abs(net) < num(P.HCP_STEP, 0.125)) notes.push('两队伤停影响几乎抵消（|净分差| 不足一档），不改变盘口');
    return {
      home: h, away: a, net: net, ball: ball, ballText: ballText,
      netText: (net >= 0 ? '主队少缺人 ' : '客队少缺人 ') + Math.abs(net).toFixed(3) + ' 分' +
        (ball > 0 ? '，约折算 ' + ballText : ''),
      notes: notes,
    };
  }

  /* ---------------- 11j. 转会窗口 ---------------- */
  const TRANSFER_WINDOWS = [
    { lg: '英超', sum: { from: '06-15', to: '09-01', hm: '23:00', tz: 'BST' }, win: { from: '01-01', to: '02-01', hm: '23:00', tz: 'GMT' } },
    { lg: '西甲', sum: { from: '07-01', to: '09-01', hm: '23:59', tz: 'CET' }, win: { from: '01-02', to: '02-02', hm: '23:59', tz: 'CET' } },
    { lg: '意甲', sum: { from: '06-29', to: '09-01', hm: '20:00', tz: 'CET' }, win: { from: '01-02', to: '02-01', hm: '20:00', tz: 'CET' } },
    { lg: '德甲', sum: { from: '07-01', to: '09-01', hm: '20:00', tz: 'CET' }, win: { from: '01-01', to: '01-31', hm: '20:00', tz: 'CET' } },
    { lg: '法甲', sum: { from: '06-15', to: '09-01', hm: '19:59', tz: 'CET' }, win: { from: '01-01', to: '02-01', hm: '19:59', tz: 'CET' } },
  ];
  /** 计算某个转会窗口相对 now 的状态 */
  function windowState(w, now) {
    now = now || new Date();
    const y = now.getFullYear();
    const mk = function (md, hm) {
      const p = String(md).split('-');
      const t = String(hm || '23:59').split(':');
      return new Date(y, parseInt(p[0], 10) - 1, parseInt(p[1], 10), parseInt(t[0], 10), parseInt(t[1], 10));
    };
    let from = mk(w.from, '00:00'), to = mk(w.to, w.hm);
    // 冬季窗跨年处理：如果结束时间已过很久，算到明年
    if (to < from) to = new Date(to.getFullYear() + 1, to.getMonth(), to.getDate(), to.getHours(), to.getMinutes());
    let state, days;
    if (now < from) {
      state = '未开启';
      days = Math.ceil((from - now) / 86400000);
    } else if (now <= to) {
      state = '进行中';
      days = Math.ceil((to - now) / 86400000);
    } else {
      state = '已关闭';
      days = -Math.floor((now - to) / 86400000);
    }
    return { state: state, days: days, from: from, to: to, fromText: w.from, toText: w.to, hm: w.hm, tz: w.tz };
  }
  function transferStatus(LIB, now) {
    const list = (LIB && LIB.transferWindows) || TRANSFER_WINDOWS;
    return list.map(function (row) {
      return {
        lg: row.lg,
        summer: windowState(row.sum, now),
        winter: windowState(row.win, now),
      };
    });
  }

  /* ---------------- 11k. 决策树：机构意图研判（三步法） ---------------- */
  const BREAKEVEN = 0.5128;   // 水位 0.95 时的理论保本胜率

  /* ---------------- 11f2. 伤停量化默认值（供调参中心与自检共用） ---------------- */
  const INJURY_DEFAULTS = {
    EDGE_NUM: 40, EDGE_PCT: 0.10, POOL_MIN: 18, GK_KEEP: 2,
    W_START: 1.00, W_SUB_PLAYED: 0.45, W_BENCH: 0.15, W_OUT: 0.02, W_NEW: 0.60,
    LOSS_T1: 0.04, LOSS_T2: 0.10, LOSS_T3: 0.18, LOSS_T4: 0.27, LOSS_T5: 0.35,
    DEPTH_XI: 11,
    DEPTH_HI: 0.28, DEPTH_LO: 0.19,          // squad 口径（修正版，按 114 队实测 20/60/20 分位定标）
    DEPTH_RES_HI: 0.88, DEPTH_RES_LO: 0.75,  // residual 口径（规则原文，保留可选）
    DEPTH_FORCE: 1,                          // 无伤病时强制「深度一般」（规则原文的保护规则 1）
  };

  /* ---------------- 11g. 基本面方向 / 中水二次判定 / 盘口不变建议（v13） ---------------- */
  /**
   * 基本面方向 —— 四票一致数量 X 的三分类
   *   =IF(X>=3,"支持主队", IF(X=2,"有平局", IF(X<=1,"支撑客队","中性")))
   * X = 一致数量 = 攻防/主战绩/排名/加减 四票里「正」的个数，取值 0~4。
   * ★ 这四票全部是「主队 − 客队」视角，所以 X 越大 = 越支持**主队**，
   *   与「谁是让球方（上盘）」无关。X≥3 只在主队是让球方时才等于「支持上盘」。
   */
  function fundamentalDir(r) {
    const X = num(r.consensus, 0);
    if (X >= 3) return { code: 'home', text: '支持主队', X: X };
    if (X === 2) return { code: 'draw', text: '有平局', X: X };
    if (X <= 1) return { code: 'away', text: '支撑客队', X: X };
    return { code: 'neutral', text: '中性', X: X };
  }
  /**
   * 机构让球方（上盘方）判定 —— v14.1
   *  ① 初盘 J ≠ 0            → 符号定：J < 0 主队上盘；J > 0 客队上盘
   *  ② J = 0 但 终盘 K ≠ 0   → 用终盘符号（初盘开平手、临场才让出球）
   *  ③ J = K = 0（平手盘）    → 靠水位判：水位低的一方是上盘；两边都是中水 → 平手，不推荐方向
   * 返回 { side: -1 主队 / +1 客队 / 0 平手, upSide, from }
   */
  function resolveUpper(J, K, Lw, Mw, P, LIB) {
    P = P || store.P;
    const j = (J === null || J === undefined) ? null : num(J, 0);
    const k = (K === null || K === undefined) ? null : num(K, 0);
    if (j !== null && j !== 0) {
      return { side: j < 0 ? -1 : 1, upSide: j < 0 ? '主队' : '客队', from: 'J' };
    }
    if (k !== null && k !== 0) {
      return { side: k < 0 ? -1 : 1, upSide: k < 0 ? '主队' : '客队', from: 'K' };
    }
    /* ③ 平手盘：让球为 0，机构只能用「水位」表达强弱 —— 水位低的一方是热门（上盘）。
     *   用 LIB.flatWaterMode 选口径：
     *   · 'columns'（默认）：平手盘时「初盘水位」填主队一侧、「终盘水位」填客队一侧 → 直接比这两个数
     *   · 'home'           ：两栏都是**主队**水位（初盘 / 终盘两个时点）→ 与中水档比，低水=主队上盘、高水=客队上盘
     *   · 'alwaysHome'     ：平手盘一律以**主队**为上盘，不看水位
     *   两侧都落在中水档 → 机构没表态 → 平手，不推荐方向。
     *   水位缺失 / 判不出来 → 按 LIB.flatWaterDefault（默认 'home' = 主队为上盘）兜底。 */
    const mode = (LIB && LIB.flatWaterMode) || 'columns';
    const midNames = (LIB && LIB.midWaterNames) || ['中水'];
    const sum = num(P.WATER_SUM, 2);
    const rd2 = function (x) { return Math.round(x * 100) / 100; };
    const inMid = function (lv) { return midNames.indexOf(lv) >= 0; };
    const fallback = function (why) {
      const fb = (LIB && LIB.flatWaterDefault) || 'home';
      if (fb === 'home') {
        return {
          side: -1, upSide: '主队', from: 'default',
          note: '平手盘（初盘终盘都是 0 球）' + (why ? '，' + why : '') + ' → 按默认设定：**主队为上盘**',
        };
      }
      return { side: 0, upSide: '平手', from: 'none', note: '平手盘' + (why ? '，' + why : '') + '，判不出上盘' };
    };

    if (mode === 'alwaysHome') {
      return fallback('口径设定为「一律以主队为上盘」');
    }

    let wh = null, wa = null, src = '';
    if (mode === 'home') {
      /* 两栏都是主队水位：先看是不是「初盘、终盘都是中水」→ 不推荐；
       * 否则用初盘水位判（与场景口径一致），初盘是中水就改用终盘。 */
      const lvL0 = Lw ? waterLevel(Lw, P) : '', lvM0 = Mw ? waterLevel(Mw, P) : '';
      if (Lw && Mw && inMid(lvL0) && inMid(lvM0)) {
        return {
          side: 0, upSide: '平手', from: 'water', w: Lw, other: Mw, lvW: lvL0, lvO: lvM0,
          note: '平手盘 · 初盘水位与终盘水位都是中水（' + Lw + ' / ' + Mw + '）—— 机构没表态，不推荐方向',
        };
      }
      const wH = (Lw && !inMid(lvL0)) ? Lw : (Mw || Lw);
      if (!wH) return fallback('没填水位');
      wh = wH; wa = rd2(sum - wH);
      src = '平手盘 → 记录的是<b>主队水位</b> ' + wH + '（' + waterLevel(wH, P) + '），' +
        '客队按水位之和 ' + sum + ' 推得 ' + wa;
    } else if (mode === 'columns' && Lw && Mw) {
      wh = Lw; wa = Mw;
      src = '平手盘 → <b>初盘水位记主队</b>、<b>终盘水位记客队</b>';
    } else if (Lw || Mw) {
      const w0 = (Lw || Mw);
      const o0 = rd2(sum - w0);
      wh = w0; wa = o0;
      src = '平手盘 → 记录的是主队水位 ' + w0 + '，客队按水位之和 − ' + w0 + ' = ' + o0;
    } else {
      return fallback('没填水位');
    }
    if (!wh || !wa) return fallback('水位不全');
    const lvH = waterLevel(wh, P), lvA = waterLevel(wa, P);
    if (inMid(lvH) && inMid(lvA)) {
      return {
        side: 0, upSide: '平手', from: 'water', w: wh, other: wa, lvW: lvH, lvO: lvA,
        note: '平手盘 · 两侧都是中水（主 ' + wh + ' / 客 ' + wa + '）—— 机构没表态，不推荐方向',
      };
    }
    const homeIsUp = wh < wa;
    return {
      side: homeIsUp ? -1 : 1, upSide: homeIsUp ? '主队' : '客队', from: 'water',
      w: wh, other: wa, lvW: lvH, lvO: lvA,
      note: src + '：水位低的一方是上盘 → **' + (homeIsUp ? '主队' : '客队') + '**' +
        '（主 ' + wh + ' ' + lvH + ' / 客 ' + wa + ' ' + lvA + '）',
    };
  }
  /** 兼容旧键：平手盘 sum 口径下记录的是哪一侧 */
  function flatWaterRef(P, LIB) {
    if (LIB && LIB.flatWaterRef) return LIB.flatWaterRef;
    return (P && P.FLAT_WATER_REF) || 'home';
  }
  /** 主队是不是让球方（上盘方）—— 用 evaluate 存好的 upSide，没有就回退到 J 的符号 */
  function homeIsUpper(r) {
    if (r && r.upSide !== undefined) return r.upSide === '主队';
    return num(r.J, 0) < 0;
  }
  function upperTeam(r) {
    if (r && r.upSide !== undefined) return r.upSide;
    return num(r.J, 0) < 0 ? '主队' : (num(r.J, 0) > 0 ? '客队' : '平手');
  }
  function lowerTeam(r) { return upperTeam(r) === '主队' ? '客队' : (upperTeam(r) === '客队' ? '主队' : '平手'); }
  /** 「上盘方是从哪判出来的」→ 人话 */
  function upperFromLabel(from) {
    if (from === 'J') return '初盘盘口符号';
    if (from === 'K') return '终盘盘口符号';
    if (from === 'water') return '平手盘看水位';
    if (from === 'manual') return '手动指定';
    if (from === 'none') return '判不出来';
    return '默认兜底（水位不全 → 按主队为上盘）';
  }
  /** 中水四场景的「风险提示」文字（只提示风险，不再反转方向） */
  function midRiskHint(scene) {
    const S = LABELS.scene;
    if (scene === S.m1) return '注意：深开 + 升盘 + 中水，机构态度待验证';
    if (scene === S.m2) return '注意：深开 + 降盘 + 中水，机构有诱上嫌疑';
    if (scene === S.m3) return '注意：浅开 + 升盘 + 中水，机构有诱上嫌疑';
    if (scene === S.m4) return '注意：浅开 + 降盘 + 中水，机构可能在给上盘补防';
    return '';
  }
  /**
   * 基本面是不是支持「上盘那一方」。
   *   上盘是主队 → X≥3 支持上盘
   *   上盘是客队 → X≤1 支持上盘
   * wide=true 时把「有平局(X=2)」也算作支持（盘口不变·中水那条反向规则要用）
   */
  function supportUpper(r, wide) {
    const X = num(r.consensus, 0);
    if (X === 2) return !!wide;
    return homeIsUpper(r) ? (X >= 3) : (X <= 1);
  }
  function supportLower(r, wide) {
    const X = num(r.consensus, 0);
    if (X === 2) return !!wide;
    return homeIsUpper(r) ? (X <= 1) : (X >= 3);
  }
  /**
   * 中水二次判定（★ v15 重定基准：一律以「基本面四项占优方向」为准）
   *
   * 为什么改：旧逻辑用场景名（深升/深降/浅升/浅降）去**反转或否决**方向，于是出现
   *   「二次判定说⚠️警惕（下盘），推荐引擎说买上盘」这种自相矛盾的输出。
   *   按你的口径 —— **基本面四项（攻防 / 主战绩 / 排名 / 加减）占优的那一边就是投注方向**。
   *
   * 现在只有两种情况仍然不给方向（直接放弃，且给出理由）：
   *   ① 一票否决（totalDivergence 等）—— 最典型的诱盘
   *   ② 偏差太小（初盘 ≈ 心盘，机构没表态、没有信息量）
   * 其余情况：方向 = 基本面占优方；场景名只作为**风险提示**文字，不再反转方向。
   */
  function midVerdict(r) {
    if (!isMidScene(r.scene)) return { text: '—', tone: 'mute', dir: null, basis: '' };
    const X = num(r.consensus, 0);
    const ak = fundamentalDir(r).text;
    const upT = upperTeam(r);
    if (arbIsVeto(r)) {
      return {
        text: '有重大利空（' + (r.arb || '一票否决') + '），基本面' + ak + '，❌ 放弃：不投上盘，也不建议反向下盘',
        tone: 'bad', dir: null, basis: 'veto',
      };
    }
    if (num(r.devScore, 0) <= 1) {
      return {
        text: '偏差太小（初盘几乎等于心盘，机构等于没表态），基本面' + ak + '，⚠️ 放弃',
        tone: 'warn', dir: null, basis: 'dev',
      };
    }
    const sup = supportUpper(r);
    const dir = sup ? 'up' : 'down';
    const risk = midRiskHint(r.scene);
    let tail;
    if (X === 2) tail = '（四票 2:2 打平，按规则偏下盘，属弱信号）';
    else if (sup) tail = '（四票 ' + X + '/4 占优 → 支持' + upT + '，即上盘）';
    else tail = '（四票 ' + X + '/4 不支持' + upT + '，即上盘）';
    return {
      text: '基本面四项占优 → 买' + (dir === 'up' ? '上盘' : '下盘') + tail + (risk ? '；' + risk : ''),
      tone: X === 2 ? 'mute' : 'ok',
      dir: dir, basis: 'fundamental',
    };
  }
  /**
   * 盘口不变方向建议（v13）
   *   =IF(LEFT(R,4)<>"盘口不变","",
   *     IF(R="盘口不变·中水","— 中水待定",
   *     IF(I<0, IF(X>=3,"✅ 看好上盘（主队）", IF(X<=1,"❌ 看衰上盘（主队）","— 有平局")),
   *     IF(I>0, IF(X<=1,"✅ 看好上盘（客队）", IF(X>=3,"❌ 看衰上盘（客队）","— 有平局")),
   *     "— 平手"))))
   */
  function flatAdvice(r) {
    const S = LABELS.scene;
    if (r.scene !== S.fh && r.scene !== S.fl && r.scene !== S.fm) return { text: '—', tone: 'mute', dir: null };
    if (r.scene === S.fm) return { text: '— 中水待定', tone: 'mute', dir: null };
    const X = num(r.consensus, 0);
    if (X === 2) return { text: '— 有平局', tone: 'mute', dir: 'down' };
    if (homeIsUpper(r)) {
      if (X >= 3) return { text: '✅ 看好上盘（主队）', tone: 'ok', dir: 'up' };
      return { text: '❌ 看衰上盘（主队）', tone: 'bad', dir: 'down' };
    }
    if (X <= 1) return { text: '✅ 看好上盘（客队）', tone: 'ok', dir: 'up' };
    return { text: '❌ 看衰上盘（客队）', tone: 'bad', dir: 'down' };
  }

  /* ---------------- 11h. 统一推荐引擎（v13） ---------------- */
  const REC_CASES = {
    A: { n: '机构意图（8 大场景）', why: '场景名直接给出方向，按该场景历史准确率推荐' },
    B1: { n: '盘口不变·高/低水（看基本面）', why: '看不出机构意图 → 看基本面 X2 支持谁' },
    B2: { n: '盘口不变·中水（反向判定）', why: '机构控水不给方向 + 基本面偏向热门 → 反着买' },
    B3: { n: '中水四场景（基本面补位）', why: '中水光看名字定不了方向 → 用 X2 补位（二次判定照旧不改）' },
    none: { n: '不参与', why: '平手或错误 —— 机构没给意图，基本面也没形成倾向' },
  };
  /**
   * v13 统一推荐：先看是不是 8 大场景；不是的话分「盘口不变」和「中水四场景」两支。
   *
   *   A  场景1~8（机构意图明确）→ 方向 = 场景名指向；排序分主要看该场景历史命中率
   *   B1 盘口不变·高水/低水      → 方向 = 基本面支持谁（AM 列口径）
   *   B2 盘口不变·中水           → 反向：基本面偏向热门（含平局）→ 买下盘；否则买上盘
   *   B3 中水四场景              → 方向 = 基本面支持谁（X2 补位）；AL 二次判定作为参考（原有判定不改）
   */
  function recommend(r, agg) {
    agg = agg || {};
    const S = LABELS.scene;
    const X = num(r.consensus, 0);
    const ak = fundamentalDir(r);
    const upT = upperTeam(r), lowT = lowerTeam(r);
    const al = midVerdict(r);
    const am = flatAdvice(r);
    const isScene8 = /^场景\d/.test(String(r.scene || ''));
    const isMid = isMidScene(r.scene);
    const isFlat = (r.scene === S.fh || r.scene === S.fl);
    const isFlatMid = (r.scene === S.fm);

    const mk = function (key, dir, score, reasons, conf) {
      const side = dir === 'up' ? '上盘' : dir === 'down' ? '下盘' : '不选';
      const team = dir === 'up' ? upT : dir === 'down' ? lowT : '—';
      return {
        caseKey: key, caseName: REC_CASES[key] ? REC_CASES[key].n : key,
        caseWhy: REC_CASES[key] ? REC_CASES[key].why : '',
        dir: dir, side: side, team: team,
        line: dir === 'none' ? '不参与' : '买 ' + team + '（' + side + '）',
        score: score, ak: ak.text, X: X, upTeam: upT,
        al: al.text, alTone: al.tone, alDir: al.dir,
        am: am.text, amTone: am.tone,
        reasons: reasons, conf: conf || '中',
      };
    };

    /* ---- A：8 大场景（机构意图明确） ---- */
    if (isScene8) {
      const ss = sceneSide(r.scene, store.LIB);
      const g = ((agg.side || {}).byScene || {})[sceneKeyOf(r.scene)] || { n: 0, dn: 0, w: 0, rate: null, lo: 0 };
      const dir = ss.dir === 'down' ? 'down' : 'up';
      const rs = [];
      rs.push('场景名「' + ss.word + '」→ ' + ss.label + '（' + String(ss.why).replace(/<[^>]+>/g, '') + '）');
      rs.push(g.dn
        ? ('这个场景历史上按方向买 ' + pct(g.rate) + '（' + g.w + '/' + g.dn + '），Wilson 下界 ' + pct(g.lo))
        : '这个场景还没有已开奖样本，暂时只能按场景名判方向');
      rs.push('基本面：X2 = ' + X + ' → ' + ak.text + '（上盘是' + upT + '）');
      if (arbIsVeto(r)) rs.push('⚠ ' + r.arb + ' —— ' + r.arbWhy);
      const conf = (g.dn >= 5 && g.lo > BREAKEVEN) ? '高' : (arbIsOk(r) ? '中' : '低');
      const score = (g.dn ? g.lo * 100 : 30) + r.total * 0.6 + (arbIsOk(r) ? 8 : 0)
        - (arbIsVeto(r) ? 40 : 0);
      return mk('A', dir, score, rs, conf);
    }

    /* ---- B3：中水四场景（X2 补位） ---- */
    if (isMid) {
      const sup = supportUpper(r);
      const dir = sup ? 'up' : 'down';
      const rs = [];
      rs.push('基本面：X2 = ' + X + ' → ' + ak.text + '（四票都是主队视角，X2 大 = 支持主队）');
      rs.push('上盘是' + upT + ' → 基本面' + (sup ? '支持' : '不支持') + '上盘 → 买' + (dir === 'up' ? '上盘' : '下盘'));
      rs.push('中水场景光看名字定不了方向，所以用 X2 补位；原有二次判定不改，单独列在下面');
      rs.push('中水二次判定：' + al.text);
      if (al.dir && al.dir === dir) rs.push('二次判定与基本面一致，可信度更高');
      else if (al.dir && al.dir !== dir) rs.push('⚠ 二次判定与基本面相反，建议减仓或跳过');
      if (arbIsVeto(r)) rs.push('⚠ ' + r.arb + ' —— ' + r.arbWhy);
      const conf = (al.dir === dir && al.dir) ? '高' : (arbIsVeto(r) ? '低' : '中');
      const score = 50 + r.total * 0.8 + ((al.dir === dir && al.dir) ? 15 : 0) - (arbIsVeto(r) ? 30 : 0);
      return mk('B3', dir, score, rs, conf);
    }

    /* ---- B2：盘口不变·中水（反向规则） ---- */
    if (isFlatMid) {
      const wide = supportUpper(r, true);
      const dir = wide ? 'down' : 'up';
      const rs = [];
      rs.push('盘口不变 + 中水 → 机构在控水，没给方向');
      rs.push('基本面：X2 = ' + X + ' → ' + ak.text + '（上盘是' + upT + '）');
      rs.push(wide
        ? ('基本面偏向热门（X2 ' + (homeIsUpper(r) ? '≥2' : '≤2') + '）而机构只给中水不配合 —— 热门打不出来，反着买' + (dir === 'down' ? '下盘' : '上盘'))
        : ('基本面完全不支持热门（X2 ' + (homeIsUpper(r) ? '≤1' : '≥3') + '）—— 热门反而能打出，跟上盘'));
      rs.push('AM 盘口不变方向建议：' + am.text + '（公式里中水这一档是「待定」，网页按上面的文字规则补了反向判定）');
      return mk('B2', dir, 45 + r.total * 0.5, rs, '中');
    }

    /* ---- B1：盘口不变·高水 / 低水（看基本面） ---- */
    if (isFlat) {
      const sup = supportUpper(r);
      const dir = sup ? 'up' : 'down';
      const rs = [];
      rs.push('盘口不变 + ' + r.water + ' → 机构只是调水位，方向要从基本面看');
      rs.push('基本面：X2 = ' + X + ' → ' + ak.text + '（上盘是' + upT + '，所以基本面' + (sup ? '支持' : '不支持') + '上盘）');
      rs.push('AM 盘口不变方向建议：' + am.text);
      if (arbIsVeto(r)) rs.push('⚠ ' + r.arb + ' —— ' + r.arbWhy);
      const conf = (arbIsOk(r) && r.strength === '强') ? '高' : (arbIsVeto(r) ? '低' : '中');
      const score = 55 + r.total * 0.8 + (X === 2 ? -10 : 0) - (arbIsVeto(r) ? 35 : 0);
      return mk('B1', dir, score, rs, conf);
    }

    /* ---- 平手或错误 ---- */
    return mk('none', 'none', 0, [
      '场景落到「平手或错误」—— 既不是 8 大场景，也不是盘口不变的高/低/中水，也不是中水四场景',
      '机构没有形成明确意图，本场不参与',
    ], '低');
  }

  /**
   * 推荐准确率统计：按推荐情形分组，算「推荐方向是否赢盘」。
   * 走水与未开奖都排除在「已开奖」之外。
   */
  function recommendStats(recs, P, LIB) {
    recs = recs || store.rows;
    P = P || store.P; LIB = LIB || store.LIB;
    const agg = groupRates(recs, P, LIB);
    const rows = recs.map(function (rec) {
      const r = evaluate(rec.inp, P, LIB);
      const rc = recommend(r, agg);
      let res = null;
      if (rc.dir !== 'none' && (r.actual === '赢盘' || r.actual === '输盘')) {
        const upWin = r.actual === '赢盘';
        const win = (rc.dir === 'up') ? upWin : !upWin;
        const wUp = num(rec.inp.closeWater !== '' && rec.inp.closeWater !== undefined ? rec.inp.closeWater : rec.inp.openWater, 0.95);
        const water = rc.dir === 'down' ? Math.max(0.5, Math.round((num(P.WATER_SUM, 2) - wUp) * 100) / 100) : wUp;
        res = { win: win, water: water, profit: win ? (water - 1) : -1 };
      }
      return { rec: rec, r: r, rc: rc, res: res };
    });
    const build = function (arr) {
      const dec = arr.filter(function (x) { return x.res; });
      const w = dec.filter(function (x) { return x.res.win; }).length;
      const roi = dec.length ? dec.reduce(function (a, x) { return a + x.res.profit; }, 0) / dec.length : null;
      const ci = wilson(w, dec.length);
      return {
        rows: arr, n: arr.length, recN: arr.filter(function (x) { return x.rc.dir !== 'none'; }).length,
        dn: dec.length, w: w, rate: dec.length ? w / dec.length : null,
        roi: roi, lo: ci.lo, hi: ci.hi
      };
    };
    const byCase = {};
    Object.keys(REC_CASES).forEach(function (k) {
      byCase[k] = build(rows.filter(function (x) { return x.rc.caseKey === k; }));
    });
    return { rows: rows, byCase: byCase, all: build(rows), agg: agg };
  }

  /** 决策树：机构意图研判（三步法） */
  function statHint(g, prefix) {
    if (!g || !g.dn) return prefix + '：样本不足，暂无统计规律';
    return prefix + '：' + pct(g.rate) + '（' + g.w + ' / ' + g.dn + ' 场已开奖，Wilson 下界 ' + pct(g.lo) + '）';
  }
  /**
   * 三步决策树（用户定义）：
   *   第1步 场景 → 中性盘=不参与；场景1~8 / 盘口不变=进入第2步
   *   第2步 仲裁 → 强背离=放弃；信号无效=谨慎；信号有效=进入第3步
   *   第3步 强度 → 强=重点关注；中=谨慎参考；弱=忽略
   * agg 由 groupRates() 得到，用于给每个分支附上「模型规律提示」
   */
  function decide(r, agg) {
    agg = agg || {};
    const ss = sceneSide(r.scene, store.LIB);
    const sd = sideOf(r, store.LIB);
    const gScene = (agg.scene || {})[r.scene];
    const gSide = ((agg.side || {}).byScene || {})[ss.key];
    const sc = String(r.scene || '');
    const isNeutral = sc === LABELS.scene.neutral;
    const isScene = /^场景\d/.test(sc);
    const isMid = isMidScene(sc);
    const isFlat = (sc === LABELS.scene.fh || sc === LABELS.scene.fl || sc === LABELS.scene.fm);
    const steps = [];

    /* ---- 第 1 步：场景（含「买哪一边」的指向） ---- */
    const s1 = {
      no: 1, title: '第 1 步 · 看场景（R 列）', value: sc,
      status: isNeutral ? 'neutral' : (isMid ? 'mid' : (isScene ? 'scene' : 'flat')),
      pass: !isNeutral,
      text: (isNeutral
        ? '平手或错误 —— 既不是标准 8 场景，也不是中水四场景（心盘正好平手，或水档/盘口组合对不上）。本场不参与方向判断。'
        : isScene
          ? sc + ' —— 匹配到标准八大场景之一，进入第 2 步。'
          : isMid
            ? sc + ' —— v12 新增的中水场景：中水本身信号很弱，光看名字定不了方向，要靠「中水二次判定」二次确认。'
            : sc + '（盘口没动、只有水位在变）—— 不属于标准 8 场景，但仍有方向含义，进入第 2 步。') +
        (sd.dir === 'none' ? (isMid ? '<br><b>方向指向：</b>' + (r.midVerdict || '—') : '') : '<br><b>方向指向：' + sd.text + '</b>（' + ss.label + '）'),
      hint: (isNeutral ? statHint(gScene, '平手或错误历史') : statHint(gScene, '同场景历史')) +
        ((sd.dir === 'none') ? '' : '　·　' + statHint(gSide, '按本场景方向买历史')),
      tip: sd.dir === 'none'
        ? (isNeutral
          ? '模型规律提示：这类场次占「平手」和「盘口不变但水档异常」两种，机构没有形成明确意图，统计上接近抛硬币，' +
          '建议直接跳过。'
          : isMid
            ? '模型规律提示：中水场景是 v12 新增的「待验证」区 —— 中水意味着机构既没给高水也没给低水，' +
            '信号强度天然不足。判据是<b>中水二次判定</b>：强背离或偏差评分 ≤ 1 直接放弃，' +
            '否则再看四票一致数量 X（深升/浅降要 X≥3，深降/浅升要 X≤2）才能定方向。'
            : '模型规律提示：盘口不变只调水位，通常代表机构在「控水」而不是「改方向」，方向参考价值低于标准 8 场景。')
        : '<b>场景名的方向指向：</b>' + sd.why +
          '<br>模型规律提示：8 大场景的名字本身就是结论 —— 「阻上 / 强支 / 补防 / 诱下」是跟上盘，' +
          '「诱上 / 看衰」是反着买下盘。场景 4 / 5 / 6 属于反向场景，1 / 2 / 3 / 7 / 8 属于正向场景。',
    };
    steps.push(s1);

    /* ---- 第 2 步：仲裁（v14：方向对称，以上盘方为基准） ---- */
    const gArb = (agg.arb || {})[r.arb];
    const arbKey = r.arbKey || '';
    const isVeto = arbIsVeto(r);
    const isBad = arbIsBad(r);
    const isCaution = arbIsCaution(r);
    let arbPass = false;
    if (!isNeutral) {
      const pass2 = (r.arbPass !== undefined) ? (r.arbPass && !isVeto) : (!isVeto && !isBad);
      const s2 = {
        no: 2, title: '第 2 步 · 看仲裁结论', value: r.arb,
        status: isVeto ? 'veto' : (isBad ? 'invalid' : (isCaution ? 'caution' : 'valid')),
        pass: pass2,
        text: (r.arbWhy || '') +
          (isVeto ? '<br><b>一票否决 → 直接放弃。</b>'
            : isBad ? '<br><b>机构让球方向有风险 → 最多小注或跳过。</b>'
              : isCaution ? '<br><b>机构与模型长期相反 → 谨慎，建议减仓。</b>'
                : '<br><b>通过。</b>'),
        hint: statHint(gArb, '同类仲裁历史'),
        tip: '仲裁现在以<b>机构让球方（上盘方）</b>为基准，方向对称 —— ' +
          '「长期实力（攻防+主战绩+排名）」与「短期突发（加减）」是否支持机构让的那个方向。' +
          '<br>旧口径问的是「主队是否占优」，只在主队让球时与下注方向一致，客让盘会整反。' +
          '<br>在「调参中心 → 映射表 → 仲裁口径」可以切回旧口径对照。',
      };
      steps.push(s2);
      arbPass = pass2;
    }

    /* ---- 第 3 步：强度 ---- */
    if (arbPass) {
      const gSt = (agg.strength || {})[r.strength];
      const st = r.strength;
      const s3 = {
        no: 3, title: '第 3 步 · 看信号强度（AE 列）', value: st,
        status: st === '强' ? 'strong' : (st === '中' ? 'mid' : 'weak'),
        pass: st !== '弱',
        text: st === '强'
          ? '重点关注 —— 三步全部通关，四维评分 ' + round(r.total, 2) + ' 分。'
          : st === '中'
            ? '谨慎参考 —— 方向成立但强度一般，四维评分 ' + round(r.total, 2) + ' 分。'
            : '忽略 —— 四维评分只有 ' + round(r.total, 2) + ' 分，证据太弱，不做参考。',
        hint: statHint(gSt, '同强度历史'),
        tip: st === '强'
          ? '模型规律提示：评分 ≥ ' + num(store.P.STRONG_SCORE, 7) + ' 说明偏差、联动、仲裁、时间四项都在加分，是本模型里最值得出手的一档。'
          : st === '中'
            ? '模型规律提示：评分在 ' + num(store.P.MED_SCORE, 4) + ' ~ ' + num(store.P.STRONG_SCORE, 7) + ' 之间，方向对但确认度不够，适合小注或作为组合里的次选。'
            : '模型规律提示：评分 < ' + num(store.P.MED_SCORE, 4) + '，通常因为盘口变动太小、观察时间太短、或偏差评分只有 1 分。这类场次信息量不足。',
      };
      steps.push(s3);
    }

    /* ---- 汇总 ---- */
    // 「出手方向」= 场景指向那一边（不是无脑跟上盘）；中水场景看二次判定
    const betTxt = sd.dir === 'none' ? '不参与（' + (isMid ? '中水二次判定不成立' : '场景无指向') + '）' : '买 ' + sd.team + '（' + sd.side + '）';
    let level, label, action, color, score, headline;
    if (isNeutral) {
      level = 'neutral'; label = '平手或错误 · 不参与'; color = 'var(--txt-2)'; score = 0;
      action = '本场不作为投注方向依据（观望或跳过）';
      headline = '场景没匹配上，机构意图不明 —— 直接跳过。';
    } else if (isVeto) {
      level = 'veto'; label = '放弃（诱盘）'; color = 'var(--bad)'; score = -100;
      action = '直接放弃：不投上盘，也不建议反向下盘';
      headline = '触发一票否决的诱盘结构 —— 放弃。';
    } else if (isMid && sd.dir === 'none') {
      // 中水场景但二次判定没给出方向 → 与「忽略」同级，但原因不同
      level = 'midwater'; label = '中水 · 不判定'; color = 'var(--txt-3)'; score = 1;
      action = '中水信号太弱，放弃';
      headline = (r.midVerdict || '— 不判定：中水信号太弱，放弃');
    } else if (isBad) {
      level = 'invalid'; label = '谨慎（可能诱盘）'; color = 'var(--warn)'; score = 2;
      action = '最多小注，或直接跳过';
      headline = '方向证据不足，存在诱盘风险 —— 谨慎。';
    } else if (r.strength === '强') {
      level = 'strong'; label = '重点关注'; color = 'var(--ok)'; score = 5;
      action = betTxt + '　·　上盘 = ' + r.upSide + '，' + ss.label;
      headline = (isMid ? '中水二次判定通过（' + r.midVerdict + '）' : '三步全部通关且强度到位') + ' —— 重点关注。';
    } else if (r.strength === '中') {
      level = 'mid'; label = '谨慎参考'; color = 'var(--warn)'; score = 3;
      action = betTxt + '　·　小注。上盘 = ' + r.upSide + '，' + ss.label;
      headline = '方向成立但强度一般 —— 谨慎参考。';
    } else {
      level = 'weak'; label = '忽略'; color = 'var(--txt-3)'; score = 1;
      action = '不做参考';
      headline = '综合评分太低 —— 忽略。';
    }
    return {
      steps: steps, level: level, label: label, action: action, color: color,
      score: score, headline: headline, upSide: r.upSide, pan: r.corePanText,
      breakeven: BREAKEVEN,
      // 方向层
      dir: sd.dir, side: sd.side, betTeam: sd.team, betText: betTxt,
      sideLabel: ss.label, sideWhy: sd.why, sceneWord: ss.word,
      sceneKey: ss.key,
      // v12 中水层
      isMidScene: isMid, midVerdict: r.midVerdict, midTone: r.midTone,
    };
  }

  /* ---------------- 12. 参数 / 数据存取 ---------------- */
  const LS_P = 'benxin.params.v1', LS_LIB = 'benxin.lib.v1', LS_ROWS = 'benxin.rows.v1',
    LS_SET = 'benxin.settings.v1', LS_HIST = 'benxin.history.v1', LS_ITERS = 'benxin.iters.v1';

  /* ---------------- 迭代日志（模型置信度按迭代次数命名） ---------------- */
  function defaultIters() {
    return [
      {
        v: 11, date: '', note: 'v11：八大场景用有符号差值判升/降盘（存在跨零误判）；统计口径为「赢盘率」。',
        confName: '模型置信度 v11', confChanged: '首版：场景证据 + 方向证据 + 场景清晰度 + 盘口结构'
      },
      {
        v: 12, date: '', note: 'v12：① Q 深开/浅开补 I=0 分支；② R 升/降盘改用 ABS(K) vs ABS(J)，' +
          '并新增中水四场景（中水·深升/深降/浅升/浅降），兜底改名「平手或错误」；' +
          '③ 联动评分同步改用绝对值比；④ 新增「中水二次判定」；' +
          '⑤ 统计口径从「赢盘率」改为「投注盈利」；导出 87 列 → 85 列。',
        confName: '模型置信度 v12', confChanged: '口径不变，样本与场景划分随之更新（中水场景独立成组）'
      },
    ];
  }
  function saveIters() { try { localStorage.setItem(LS_ITERS, JSON.stringify(store.iters)); } catch (e) { } }
  function loadIters() {
    try {
      const raw = localStorage.getItem(LS_ITERS);
      const arr = raw ? JSON.parse(raw) : null;
      store.iters = Array.isArray(arr) && arr.length ? arr : defaultIters();
    } catch (e) { store.iters = defaultIters(); }
  }
  /** 当前迭代记录 */
  function curIter(P) {
    P = P || store.P;
    const v = num(P.ITERATION, 12);
    const list = store.iters || [];
    return list.filter(function (x) { return num(x.v, 0) === v; })[0] || { v: v, note: '（还没有为这个版本写说明）', confName: confName(P) };
  }

  function defaultParams() { const o = {}; for (const d of PARAM_DEFS) o[d.k] = d.d; return o; }
  function resetParams() { store.P = defaultParams(); saveParams(); }
  function saveParams() { try { localStorage.setItem(LS_P, JSON.stringify(store.P)); } catch (e) { } }
  function loadParams() {
    store.P = defaultParams();
    try {
      const raw = localStorage.getItem(LS_P);
      if (raw) {
        const o = JSON.parse(raw);
        for (const d of PARAM_DEFS) if (d.k in o) store.P[d.k] = o[d.k];
        // 兼容旧版本：把过低的保留位数抬到 8，避免逐位对账时出现 1e-5 级误差
        if (store.P.AD_BIGWIN_ROUND < 8) store.P.AD_BIGWIN_ROUND = 8;
      }
    } catch (e) { }
  }
  function saveLib() { try { localStorage.setItem(LS_LIB, JSON.stringify(store.LIB)); } catch (e) { } }
  function loadLib() {
    store.LIB = JSON.parse(JSON.stringify(DEFAULT_LIB));
    try {
      const raw = localStorage.getItem(LS_LIB);
      if (raw) {
        const o = JSON.parse(raw);
        for (const k of Object.keys(DEFAULT_LIB)) if (o[k]) store.LIB[k] = o[k];
      }
    } catch (e) { }
  }
  function saveRows() { try { localStorage.setItem(LS_ROWS, JSON.stringify(store.rows)); } catch (e) { } }
  function loadRows() {
    try { const raw = localStorage.getItem(LS_ROWS); store.rows = raw ? JSON.parse(raw) : []; }
    catch (e) { store.rows = []; }
    if (!Array.isArray(store.rows)) store.rows = [];
    store.seq = store.rows.reduce((m, r) => Math.max(m, num(r.seq, 0)), 0);
  }
  /**
   * 数据迁移 / 修复：把出厂示例里已验证过的字段，补到「同主队且该字段为空」的记录上。
   * 只填空值，绝不覆盖你自己填过的数据。每次启动都会跑一遍。
   *
   * 主要用途：早期版本没有「近 6 场实际场次」这个输入，老记录缺它时心盘会算偏。
   */
  function migrateRows() {
    const fix = {};
    (global.SEED_ROWS || []).forEach(function (r) {
      if (!r || !r.home) return;
      fix[r.home] = {
        hADGames: r.hADGames, aADGames: r.aADGames,
        hGames: r.hGames, hPts: r.hPts, aGames: r.aGames, aPts: r.aPts,
      };
    });
    let n = 0;
    store.rows.forEach(function (rec) {
      if (!rec || !rec.inp) return;
      const f = fix[rec.inp.home];
      if (!f) return;
      for (const k in f) {
        if (f[k] === undefined || f[k] === null || f[k] === '') continue;
        const cur = rec.inp[k];
        if (cur === undefined || cur === null || cur === '') { rec.inp[k] = f[k]; n++; }
      }
    });
    if (n) saveRows();
    return n;
  }
  /** 体检：找出会显著影响结果的缺失字段 */
  function auditRows() {
    const out = [];
    const blank = function (v) { return v === undefined || v === null || v === ''; };
    store.rows.forEach(function (rec) {
      const inp = rec.inp || {};
      const miss = [];
      if (blank(inp.hADGames)) miss.push('hADGames');
      if (blank(inp.aADGames)) miss.push('aADGames');
      if (!(inp.league in store.LIB.leagues)) miss.push('league');
      if (blank(inp.open)) miss.push('open');
      // ★ v15：水位缺失比「近 6 场实际场次」缺失更严重 —— 它会直接让八大场景判不出来
      if (blank(inp.openWater)) miss.push('openWater');
      if (miss.length) {
        const slotsH = [1, 2, 3, 4, 5, 6].filter(function (i) { return inp['hG' + i] !== undefined && inp['hG' + i] !== ''; }).length;
        const slotsA = [1, 2, 3, 4, 5, 6].filter(function (i) { return inp['aG' + i] !== undefined && inp['aG' + i] !== ''; }).length;
        out.push({
          rec: rec, seq: rec.seq, miss: miss,
          slotsH: slotsH, slotsA: slotsA,
          label: (inp.home || '?') + ' vs ' + (inp.away || '?') + '  #' + rec.seq,
        });
      }
    });
    return out;
  }
  function saveSettings() { try { localStorage.setItem(LS_SET, JSON.stringify(store.settings)); } catch (e) { } }
  function loadSettings() {
    try { const raw = localStorage.getItem(LS_SET); if (raw) Object.assign(store.settings, JSON.parse(raw)); } catch (e) { }
  }
  function saveHistory() { try { localStorage.setItem(LS_HIST, JSON.stringify(store.history.slice(-60))); } catch (e) { } }
  function loadHistory() { try { const raw = localStorage.getItem(LS_HIST); store.history = raw ? JSON.parse(raw) : []; } catch (e) { store.history = []; } }

  /* ==========================================================================
   * 14. 记录的列定义（导出 / 导入 / 表格视图共用）
   * --------------------------------------------------------------------------
   * 一组记录 = 一场比赛。列分四段：
   *   RECORD_HEADERS  比赛概要（人看的）
   *   MATCH_HEADERS   每场输入明细 + 引擎算出的文本标签（导入时会重算）
   *   VERDICT_HEADERS 中水二次判定
   *   STAT_HEADERS    逐行统计块
   *   EXTRA_HEADERS   两个可选输入（近 6 场实际场次），放最后方便兼容旧文件
   * ========================================================================== */
  const RECORD_HEADERS = [
    '序号', '联赛', '轮次', '主队名称', '客队名称', '本心实力盘', '机构初盘', '机构终盘', '初盘水位', '终盘水位',
    '深开/浅开标签', '八大场景匹配', '冲突仲裁结论', '综合评分', '信号强度标签', '最终比分', '上盘是否赢盘', '备注'];
  const MATCH_HEADERS = [
    '主队第6场进球', '主队第6场失球', '主队第6场对手',
    '主队第5场进球', '主队第5场失球', '主队第5场对手',
    '主队第4场进球', '主队第4场失球', '主队第4场对手',
    '主队第3场进球', '主队第3场失球', '主队第3场对手',
    '主队第2场进球', '主队第2场失球', '主队第2场对手',
    '主队第1场进球', '主队第1场失球', '主队第1场对手',
    '客队第6场进球', '客队第6场失球', '客队第6场对手',
    '客队第5场进球', '客队第5场失球', '客队第5场对手',
    '客队第4场进球', '客队第4场失球', '客队第4场对手',
    '客队第3场进球', '客队第3场失球', '客队第3场对手',
    '客队第2场进球', '客队第2场失球', '客队第2场对手',
    '客队第1场进球', '客队第1场失球', '客队第1场对手',
    '主队主场场次', '主队主场总得分', '主队客场场次', '主队客场总得分', '是否空场',
    '主队当前排名', '客队当前排名', '主队排名区间', '客队排名区间',
    '主队历史交锋文本', '主队伤病修正文本', '主队停赛修正文本', '主队赛程疲劳修正文本',
    '主队阵容深度文本', '主队连赢连负修正文本', '主队战意状态文本',
    '客队历史交锋文本', '客队伤病修正文本', '客队停赛修正文本', '客队赛程疲劳修正文本',
    '客队阵容深度文本', '客队连赢连负修正文本', '客队战意状态文本',
    '初盘时间', '终盘时间'];
  const VERDICT_HEADERS = ['中水二次判定'];
  const STAT_HEADERS = ['统计分类', '统计项', '场次', '投注盈利场次', '投注盈利概率'];
  const EXTRA_HEADERS = ['主队近6场实际场次', '客队近6场实际场次', '手动指定上盘方'];
  const ALL_HEADERS = RECORD_HEADERS.concat(MATCH_HEADERS, VERDICT_HEADERS, STAT_HEADERS, EXTRA_HEADERS);
  /** 只含「比赛概要」的精简列（导出给 Excel / 人看的时候用） */
  const SUMMARY_HEADERS = [
    '序号', '联赛', '轮次', '主队名称', '客队名称',
    '机构初盘', '机构终盘', '初盘水位', '终盘水位', '上盘方',
    '本心实力盘', '深开/浅开标签', '八大场景匹配',
    '推荐方向', '仲裁结论', '中水二次判定',
    '综合评分', '信号强度标签',
    '最终比分', '上盘是否赢盘',
    '偏差评分', '联动评分', '仲裁评分', '时间评分',
    '备注',
  ];

  /* ---------------- 表头 → 输入字段（导入用） ---------------- */
  // 值为 null 表示「这是引擎算出来的列，导入时忽略、由引擎重算」
  const IMPORT_MAP = {
    '序号': null, '联赛': 'league', '轮次': 'round', '主队名称': 'home', '客队名称': 'away',
    '本心实力盘': null, '机构初盘': 'open', '机构终盘': 'close',
    '初盘水位': 'openWater', '终盘水位': 'closeWater',
    '深开/浅开标签': null, '八大场景匹配': null, '冲突仲裁结论': null,
    '综合评分': null, '信号强度标签': null,
    '中水二次判定': null,
    '最终比分': 'scoreText', '上盘是否赢盘': 'actual', '备注': 'note',
    '统计分类': null, '统计项': null, '场次': null,
    '投注盈利场次': null, '投注盈利概率': null,
    '赢盘场次': null, '赢盘率': null, '意图验证': null, '场景验证准确率': null,
    '主队近6场实际场次': 'hADGames', '客队近6场实际场次': 'aADGames',
    // ★ v15：手动指定机构让球方（主队 / 客队 / 平手）；空 = 自动判定
    '手动指定上盘方': 'upSideManual',
  };

  /* ---------------- 14b. 输入字段定义（表单 / 导入 / 导出共用同一份顺序） ---------------- */
  // 顺序即「标准整行」的顺序，导入导出都按它
  const INPUT_FIELDS = [
    { k: 'seq', n: '序号(可空)' },
    { k: 'league', n: '联赛', req: 1 },
    { k: 'round', n: '轮次' },
    { k: 'home', n: '主队名称' },
    { k: 'away', n: '客队名称' },
    { k: 'phCorePan', n: '本心实力盘(算出的，填“无”)' },
    { k: 'open', n: '机构初盘', req: 1 },
    { k: 'close', n: '机构终盘' },
    { k: 'openWater', n: '初盘水位', req: 1 },
    { k: 'closeWater', n: '终盘水位' },
    { k: 'phTag', n: '深开/浅开标签(算出的)' },
    { k: 'phScene', n: '八大场景匹配(算出的)' },
    { k: 'phArb', n: '冲突仲裁结论(算出的)' },
    { k: 'phTotal', n: '综合评分(算出的)' },
    { k: 'phStrength', n: '信号强度标签(算出的)' },
    { k: 'scoreText', n: '最终比分(赛后果录入)' },
    { k: 'actual', n: '上盘是否赢盘(算出的)' },
    { k: 'note', n: '备注' },
  ];
  (function () {
    for (const side of [['主', 'h'], ['客', 'a']]) {
      for (let i = 6; i >= 1; i--) {
        INPUT_FIELDS.push({ k: side[1] + 'G' + i, n: side[0] + '队第' + i + '场进球' });
        INPUT_FIELDS.push({ k: side[1] + 'C' + i, n: side[0] + '队第' + i + '场失球' });
        INPUT_FIELDS.push({ k: side[1] + 'O' + i, n: side[0] + '队第' + i + '场对手' });
      }
    }
  })();
  [
    ['hGames', '主队主场场次'], ['hPts', '主队主场总得分'],
    ['aGames', '主队客场场次'], ['aPts', '主队客场总得分'],
    ['empty', '是否空场(TRUE/FALSE)'],
    ['hRank', '主队当前排名'], ['aRank', '客队当前排名'],
    ['hTier', '主队排名区间(可空)'], ['aTier', '客队排名区间(可空)'],
    ['hHist', '主队历史交锋文本'], ['hInjury', '主队伤病修正文本'], ['hSuspend', '主队停赛修正文本'],
    ['hFatigue', '主队赛程疲劳修正文本'], ['hDepth', '主队阵容深度文本'],
    ['hStreak', '主队连赢连负修正文本'], ['hMotive', '主队战意状态文本'],
    ['aHist', '客队历史交锋文本'], ['aInjury', '客队伤病修正文本'], ['aSuspend', '客队停赛修正文本'],
    ['aFatigue', '客队赛程疲劳修正文本'], ['aDepth', '客队阵容深度文本'],
    ['aStreak', '客队连赢连负修正文本'], ['aMotive', '客队战意状态文本'],
    ['openTime', '初盘时间'], ['closeTime', '终盘时间'],
    ['hADGames', '主队近6场实际场次(可选)'], ['aADGames', '客队近6场实际场次(可选)'],
  ].forEach(function (t) { INPUT_FIELDS.push({ k: t[0], n: t[1] }); });
  const NUMERIC_INPUT = ['round', 'hRank', 'aRank', 'hGames', 'hPts', 'aGames', 'aPts',
    'openWater', 'closeWater', 'hADGames', 'aADGames', 'seq'];
  const PLACEHOLDER_INPUT = ['phCorePan', 'phTag', 'phScene', 'phArb', 'phTotal', 'phStrength'];
  const BLANK_WORDS = ['无', '空', '-', '—', '/', 'N/A', 'NA', 'null', 'undefined', '待定', '未'];

  // 表头 → 输入字段
  const H2F = {
    '联赛': 'league', '轮次': 'round', '主队名称': 'home', '客队名称': 'away',
    '机构初盘': 'open', '机构终盘': 'close', '初盘水位': 'openWater', '终盘水位': 'closeWater',
    '最终比分': 'scoreText', '备注': 'note', '初盘时间': 'openTime', '终盘时间': 'closeTime',
    '主队当前排名': 'hRank', '客队当前排名': 'aRank',
    '主队排名区间': 'hTier', '客队排名区间': 'aTier',
    '主队主场场次': 'hGames', '主队主场总得分': 'hPts', '主队客场场次': 'aGames', '主队客场总得分': 'aPts',
    '是否空场': 'empty',
    '主队历史交锋文本': 'hHist', '主队伤病修正文本': 'hInjury', '主队停赛修正文本': 'hSuspend',
    '主队赛程疲劳修正文本': 'hFatigue', '主队阵容深度文本': 'hDepth',
    '主队连赢连负修正文本': 'hStreak', '主队战意状态文本': 'hMotive',
    '客队历史交锋文本': 'aHist', '客队伤病修正文本': 'aInjury', '客队停赛修正文本': 'aSuspend',
    '客队赛程疲劳修正文本': 'aFatigue', '客队阵容深度文本': 'aDepth',
    '客队连赢连负修正文本': 'aStreak', '客队战意状态文本': 'aMotive',
  };
  (function () {
    for (let i = 6; i >= 1; i--) {
      H2F['主队第' + i + '场进球'] = 'hG' + i; H2F['主队第' + i + '场失球'] = 'hC' + i; H2F['主队第' + i + '场对手'] = 'hO' + i;
      H2F['客队第' + i + '场进球'] = 'aG' + i; H2F['客队第' + i + '场失球'] = 'aC' + i; H2F['客队第' + i + '场对手'] = 'aO' + i;
    }
  })();
  const F2H = {}; for (const k in H2F) F2H[H2F[k]] = k;
  // 把 IMPORT_MAP 里的字段也并入 H2F 索引（H2F 原本只覆盖明细列）
  for (const h in IMPORT_MAP) if (IMPORT_MAP[h] && !(h in H2F)) H2F[h] = IMPORT_MAP[h];

  /* ---------------- 文本 → 输入字段（录入与导入共用） ---------------- */
  function isBlankText(v) {
    const t = String(v == null ? '' : v).trim();
    if (t === '') return true;
    return BLANK_WORDS.indexOf(t) >= 0;
  }
  /** 返回 { skip:true } 或 { v: 值 } */
  function coerceField(k, raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (isBlankText(v)) return { skip: true };
    if (PLACEHOLDER_INPUT.indexOf(k) >= 0) return { skip: true };
    if (k === 'open' || k === 'close') {
      if (/^-?\d+(\.\d+)?$/.test(v)) return { v: parseFloat(v) };
      const pv = plateValue(v, store.P, store.LIB);
      if (pv === null) return { skip: true, bad: '盘口「' + v + '」无法识别' };
      return { v: pv };
    }
    if (NUMERIC_INPUT.indexOf(k) >= 0) {
      const n = num(v, NaN);
      if (!isFinite(n)) return { skip: true, bad: '「' + v + '」不是数字' };
      return { v: n };
    }
    if (k === 'empty') return { v: truthy(v) ? 'TRUE' : '' };
    if (k === 'openTime' || k === 'closeTime') return { v: normTimeStr(v) };
    return { v: v };
  }
  function normTimeStr(t) {
    t = String(t).trim().replace(/[.\/]/g, '-').replace(/\s+/g, ' ');
    const m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})[\sT]*(\d{1,2})?:?(\d{2})?/);
    if (!m) return t;
    const p = function (x) { return String(x === undefined ? 0 : x).padStart(2, '0'); };
    return m[1] + '-' + p(m[2]) + '-' + p(m[3]) + ' ' + p(m[4]) + ':' + p(m[5]);
  }
  /** 从一行的（表头→单元格）映射构建输入对象
   *  · 表头在 H2F 里且字段非 null → 作为输入
   *  · 表头在 H2F 里但字段为 null → 引擎算出来的列，忽略并记入 ignored
   *  · 表头不认识 → 直接跳过
   */
  function inpFromRowMap(rowMap) {
    const inp = {}; const ignored = [];
    for (const h in rowMap) {
      if (!(h in H2F)) continue;
      const f = H2F[h];
      if (!f) { ignored.push(h); continue; }
      const r = coerceField(f, rowMap[h]);
      if (!r.skip) inp[f] = r.v;
    }
    return { inp: inp, ignored: ignored };
  }

  function blankInput() {
    const o = {};
    INPUT_FIELDS.forEach(function (f) { o[f.k] = ''; });
    o.upSideManual = '';   // ★ v15：手动指定机构让球方（不在 81 列标准整行里，单独存、随 JSON/XLSX 明细一起导出）
    return o;
  }
  /** 输入对象 → 整行逗号文本（顺序 = INPUT_FIELDS；占位列写“无”） */
  function inputToComma(inp) {
    return INPUT_FIELDS.map(function (f) {
      if (PLACEHOLDER_INPUT.indexOf(f.k) >= 0) return '无';
      const v = inp ? inp[f.k] : '';
      return v === undefined || v === null ? '' : v;
    }).join(',');
  }
  /** 猜分隔符：制表符 > 全角逗号 > 半角逗号 */
  function guessDelim(text) {
    const t = String(text);
    if (t.indexOf('\t') >= 0) return '\t';
    if ((t.match(/，/g) || []).length > (t.match(/,/g) || []).length) return '，';
    return ',';
  }
  /**
   * 切一行 CSV（支持双引号包裹）。
   * ⚠ 引号**只在格子开头**才算数 —— 否则文本里出现一个孤立的 `"`（赛事备注里很常见）
   *   会让解析器进引号模式，把后面的分隔符全部吞掉，整行错位。
   */
  function splitCsvLine(text, delim) {
    const s = String(text), out = [];
    let cur = '', inQ = false, started = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"' && !started) {
        inQ = true; started = true;                 // 格子开头的引号才开始包裹
      } else if (ch === delim) {
        out.push(cur.trim()); cur = ''; started = false;
      } else {
        if (ch !== ' ' && ch !== '\t') started = true;
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }
  /**
   * 整行逗号文本 → 输入对象（`inputToComma` 的逆运算）。
   * 全角/半角逗号、制表符都能当分隔符。
   * 难点：有些下拉选项文本本身含逗号（如「下场有欧战，本场可能轮换」），
   * 直接切会多切一格 —— 这里拿参数库里的已知选项把它们合并回去。
   */
  function splitCommaLine(text, delim) {
    let cells = splitCsvLine(text, delim);
    if (delim !== '，' && delim !== ',') return cells;
    const known = [];
    ['hist', 'injury', 'suspend', 'fatigue', 'depth', 'streak', 'motive'].forEach(function (g) {
      Object.keys(store.LIB[g] || {}).forEach(function (k) {
        if (k.indexOf('，') >= 0 || k.indexOf(',') >= 0) known.push(k);
      });
    });
    let changed = true, guard = 0;
    while (changed && guard++ < 40) {
      changed = false;
      for (let i = 0; i < cells.length - 1; i++) {
        const merged = String(cells[i]).trim() + delim + String(cells[i + 1]).trim();
        if (known.indexOf(merged) >= 0) {
          cells = cells.slice(0, i).concat([merged], cells.slice(i + 2));
          changed = true; break;
        }
      }
    }
    return cells;
  }
  /** 整行文本 → 输入对象；返回 { inp, bad[], cells, delim } */
  function parseCommaLine(text) {
    const delim = guessDelim(text);
    const cells = splitCommaLine(text, delim);
    const inp = {}, bad = [];
    INPUT_FIELDS.forEach(function (f, i) {
      if (PLACEHOLDER_INPUT.indexOf(f.k) >= 0) return;
      const r = coerceField(f.k, cells[i]);
      if (r.bad) bad.push(f.n + r.bad);
      if (!r.skip) inp[f.k] = r.v;
    });
    return { inp: inp, bad: bad, cells: cells.length, delim: delim };
  }

  /**
   * 多行文本 → 多条输入对象。**这是「整行快录」的核心。**
   *   · 一行一场；空行跳过；带表头的那行自动跳过
   *   · 分隔符逐个候选（制表符 / 半角逗号 / 全角逗号）试一遍，
   *     选「切出来的格子数最接近 INPUT_FIELDS.length」的那个 —— 这样从 Excel
   *     复制的制表符文本、手写的逗号文本、带全角逗号的文本都能直接吃
   *   · 每行单独报缺项（联赛 / 机构初盘 / 初盘水位）
   * 返回 { rows:[{inp, line, cells, delim, bad:[]}], bad:[], skipped:[] }
   */
  function parseCommaText(text) {
    const raw = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
    const rows = [], bad = [], skipped = [];
    const CAND = ['\t', ',', '，'];
    raw.forEach(function (line0, idx) {
      if (!String(line0).trim()) return;              // 空行
      /* ★ 不能对整行 trim() —— 第一列「序号」经常是空的，trim 会把开头的分隔符一起吃掉，
       *   整行就错位一格（队名变成客队名之类）。空白交给下面按格 trim 处理。 */
      const line = String(line0);
      const rowNo = idx + 1;
      if (/^\s*"?序号[""]?\s*[,，\t]/.test(line)) { skipped.push('第 ' + rowNo + ' 行：表头行'); return; }

      let best = null;
      CAND.forEach(function (d) {
        const cells = splitCommaLine(line, d);
        const score = Math.abs(cells.length - INPUT_FIELDS.length);
        if (!best || score < best.score) best = { delim: d, cells: cells, score: score };
      });
      // 至少要有几个格子才当数据行（避免把一句备注也解析成比赛）
      if (!best || best.cells.length < 4) { skipped.push('第 ' + rowNo + ' 行：不像数据行，已跳过'); return; }

      const inp = {}, rowBad = [];
      INPUT_FIELDS.forEach(function (f, i) {
        if (PLACEHOLDER_INPUT.indexOf(f.k) >= 0) return;
        const r = coerceField(f.k, best.cells[i]);
        if (r.bad) rowBad.push(f.n + r.bad);
        if (!r.skip) inp[f.k] = r.v;
      });
      if (!Object.keys(inp).length) { skipped.push('第 ' + rowNo + ' 行：没解析出任何字段'); return; }

      if (!inp.league) rowBad.push('联赛为空（必填）');
      else if (!store.LIB.leagues[inp.league]) rowBad.push('联赛「' + inp.league + '」不在映射表里，会按默认值处理');
      if (inp.open === undefined) rowBad.push('机构初盘为空（场景与仲裁必需）');
      if (inp.openWater === undefined) rowBad.push('初盘水位为空');

      if (best.cells.length > INPUT_FIELDS.length + 3) {
        rowBad.push('切出 ' + best.cells.length + ' 格，远多于 ' + INPUT_FIELDS.length +
          ' 格 —— 多半是某个选项文本里带逗号，请检查加减项');
      }
      rows.push({ inp: inp, line: rowNo, cells: best.cells.length, delim: best.delim, bad: rowBad });
      rowBad.forEach(function (b) { bad.push('第 ' + rowNo + ' 行：' + b); });
    });
    return { rows: rows, bad: bad, skipped: skipped };
  }

  function newRecord(inp) {
    store.seq += 1;
    return { seq: store.seq, inp: Object.assign({}, inp), note: inp.note || '' };
  }

  /** 场景前缀：'场景5：浅开高水升盘诱上' → '场景5'；其它 → 原值 */
  function sceneKey(scene) {
    const m = String(scene || '').match(/^(场景\d)/);
    return m ? m[1] : String(scene || '');
  }
  /**
   * 逐行统计块（按场景分组）—— ★ v15：口径统一成「投注盈利」
   *
   * 旧版这里算的是「赢盘场次 ÷ 场次」，也就是**无脑看上盘赢没赢**；
   * 而全站其他地方（统计分析、投注建议、置信度校准、导出的统计表页）用的都是
   * 「**按该场景方向买**，买中才算盈利」。两个都叫"赢盘率"，含义却不同，很容易误读。
   * v15 直接删掉旧口径，只保留一个：
   *
   *   场次         = 同场景总场次
   *   已开奖       = actual 是 赢盘 / 输盘 的场次（走水、未填比分都不算）
   *   下注场次     = 已开奖 **且** 该场景给出了下注方向（dir = up / down）
   *   投注盈利场次  = 下注场次里买中的数量（买下盘时，上盘「输盘」才算中）
   *   投注盈利概率  = 投注盈利场次 ÷ 下注场次
   *
   * 「意图验证 / 场景验证准确率」保留不动 —— 它们问的是「机构意图对不对」，
   * 跟「这样下注赚不赚钱」是两个问题，不要混。
   */
  function computeStats(recs, P, LIB) {
    recs = recs || store.rows;
    P = P || store.P; LIB = LIB || store.LIB;
    const rows = recs.map(function (rec) {
      const r = evaluate(rec.inp, P, LIB);
      return { rec: rec, r: r, sd: sideOf(r, LIB), key: sceneKey(r.scene) };
    });
    const byKey = {};
    rows.forEach(function (x) { (byKey[x.key] = byKey[x.key] || []).push(x); });
    const isDecided = function (y) { return y.r.actual === '赢盘' || y.r.actual === '输盘'; };
    const hasDir = function (y) { return y.sd && (y.sd.dir === 'up' || y.sd.dir === 'down'); };
    const isBetWin = function (y) {
      if (!isDecided(y) || !hasDir(y)) return false;
      return y.sd.dir === 'up' ? (y.r.actual === '赢盘') : (y.r.actual === '输盘');
    };
    const map = {};
    rows.forEach(function (x) {
      const grp = byKey[x.key] || [];
      const decided = grp.filter(isDecided);
      const bet = grp.filter(function (y) { return isDecided(y) && hasDir(y); });
      const win = grp.filter(isBetWin).length;
      const correct = grp.filter(function (y) { return intentOf(y.r) === '正确'; }).length;
      map[x.rec.seq] = {
        '统计分类': '场景',
        '统计项': x.r.scene,
        '场次': grp.length,
        '已开奖': decided.length,
        '下注场次': bet.length,
        '投注盈利场次': win,
        '投注盈利概率': bet.length ? win / bet.length : '',
        '意图验证': intentOf(x.r),
        '场景验证准确率': grp.length ? correct / grp.length : '',
        __key: x.key, __decided: decided.length, __bet: bet.length,
      };
    });
    return map;
  }

  /**
   * 记录 → 精简行（SUMMARY_HEADERS）· 导出给 Excel / 人看的时候用
   * 只保留「一眼能读懂」的列，全部中间量走 recordToRow 的完整版。
   */
  function recordToSummary(rec) {
    const r = evaluate(rec.inp, store.P, store.LIB);
    const sd = sideOf(r, store.LIB);
    const o = {};
    o['序号'] = rec.seq;
    o['联赛'] = rec.inp.league || '';
    o['轮次'] = rec.inp.round === '' || rec.inp.round == null ? '' : num(rec.inp.round, '');
    o['主队名称'] = rec.inp.home || '';
    o['客队名称'] = rec.inp.away || '';
    o['机构初盘'] = r.J === null ? '' : r.J;
    o['机构终盘'] = r.K === null ? '' : r.K;
    o['初盘水位'] = (rec.inp.openWater === '' || rec.inp.openWater == null) ? '' : num(rec.inp.openWater, 0);
    o['终盘水位'] = (rec.inp.closeWater === '' || rec.inp.closeWater == null) ? '' : num(rec.inp.closeWater, 0);
    o['上盘方'] = r.upSide + (r.upFrom === 'J' ? '(初盘)' : r.upFrom === 'K' ? '(终盘)' :
      r.upFrom === 'water' ? '(水位)' : r.upFrom === 'manual' ? '(手动)' : r.upFrom === 'default' ? '(默认)' : '');
    o['本心实力盘'] = r.corePanText;
    o['深开/浅开标签'] = r.Q;
    o['八大场景匹配'] = r.scene;
    o['推荐方向'] = sd.dir === 'none' ? '不参与' : ('买 ' + sd.team + '（' + sd.side + '）');
    o['仲裁结论'] = r.arb;
    o['中水二次判定'] = r.midVerdict || '—';
    o['综合评分'] = r.total;
    o['信号强度标签'] = r.strength;
    o['最终比分'] = rec.inp.scoreText || '';
    o['上盘是否赢盘'] = r.actual || '';
    o['偏差评分'] = r.devScore;
    o['联动评分'] = r.linkScore;
    o['仲裁评分'] = r.arbScore;
    o['时间评分'] = r.timeScore;
    o['备注'] = rec.note || rec.inp.note || '';
    return o;
  }

  // 记录 → 完整输出行（含计算结果）
  function recordToRow(rec, statsMap) {
    const r = evaluate(rec.inp, store.P, store.LIB);
    const o = {};
    o['序号'] = rec.seq;
    o['联赛'] = rec.inp.league || '';
    o['轮次'] = rec.inp.round === '' || rec.inp.round == null ? '' : num(rec.inp.round, '');
    o['主队名称'] = rec.inp.home || '';
    o['客队名称'] = rec.inp.away || '';
    o['本心实力盘'] = r.corePanText;
    o['机构初盘'] = r.J === null ? '' : r.J;
    o['机构终盘'] = r.K === null ? '' : r.K;
    o['初盘水位'] = rec.inp.openWater === '' || rec.inp.openWater == null ? '' : num(rec.inp.openWater, 0);
    o['终盘水位'] = rec.inp.closeWater === '' || rec.inp.closeWater == null ? '' : num(rec.inp.closeWater, 0);
    o['深开/浅开标签'] = r.Q;
    o['八大场景匹配'] = r.scene;
    o['冲突仲裁结论'] = r.arb;
    o['综合评分'] = r.total;
    o['信号强度标签'] = r.strength;
    o['最终比分'] = rec.inp.scoreText || '';
    o['上盘是否赢盘'] = r.actual || '';
    o['备注'] = rec.note || rec.inp.note || '';
    for (const h of MATCH_HEADERS) {
      const f = H2F[h];
      let v = f ? rec.inp[f] : '';
      if (h === '主队排名区间') v = rec.inp.hTier || r.R.hTier;
      else if (h === '客队排名区间') v = rec.inp.aTier || r.R.aTier;
      else if (h === '是否空场') v = truthy(rec.inp.empty) ? 'TRUE' : 'FALSE';
      if (v === undefined || v === null) v = '';
      o[h] = v;
    }
    // v12：中水二次判定
    o['中水二次判定'] = r.midVerdict || '—';
    const st = statsMap && statsMap[rec.seq];
    if (st) {
      o['统计分类'] = st['统计分类']; o['统计项'] = st['统计项']; o['场次'] = st['场次'];
      o['投注盈利场次'] = st['投注盈利场次']; o['投注盈利概率'] = st['投注盈利概率'];
    } else {
      o['统计分类'] = '场景'; o['统计项'] = r.scene;
      o['场次'] = ''; o['投注盈利场次'] = ''; o['投注盈利概率'] = '';
    }
    // 两个可选输入列（无损回导时需要）
    EXTRA_HEADERS.forEach(function (h) {
      const f = IMPORT_MAP[h];
      const v = f ? rec.inp[f] : '';
      o[h] = (v === undefined || v === null) ? '' : v;
    });
    o.__r = r;
    return o;
  }
  function intentOf(r) {
    if (!r.actual) return '';
    const R = r.scene;
    if (R.indexOf('场景4') === 0 || R.indexOf('场景5') === 0 || R.indexOf('场景6') === 0)
      return (r.actual === '输盘' || r.actual === '走水') ? '正确' : '错误';
    return r.actual === '赢盘' ? '正确' : '错误';
  }

  global.Core = {
    PARAM_DEFS, DEFAULT_LIB, LABELS, TIERS,
    RECORD_HEADERS, MATCH_HEADERS, VERDICT_HEADERS, STAT_HEADERS, EXTRA_HEADERS, ALL_HEADERS, SUMMARY_HEADERS,
    INPUT_FIELDS, NUMERIC_INPUT, PLACEHOLDER_INPUT, BLANK_WORDS, IMPORT_MAP,
    H2F, F2H, blankInput, inputToComma, parseCommaLine, parseCommaText, splitCommaLine, coerceField, isBlankText, normTimeStr, inpFromRowMap,
    store, defaultParams, resetParams, saveParams, loadParams,
    saveLib, loadLib, saveRows, loadRows, saveSettings, loadSettings,
    saveHistory, loadHistory, migrateRows, auditRows,
    saveIters, loadIters, defaultIters, curIter,
    evaluate, attackDefense, formScore, rankScore, adjustScore, sceneOf,
    plateText, plateValue, lineTextOfBall, inputLine, waterLevel, moveLevel, tierOf, settle,
    clampMed, sgn, round, num, floorTo, truthy, toDate, hoursBetween,
    wilson, pct, groupRates, decide, statHint, BREAKEVEN,
    sceneKeyOf, sceneSide, sideOf, sideRates,
    hcpMove, depthLabel, sceneOf, HCP_EPS,
    isMidScene, midVerdict, midRiskHint,
    fundamentalDir, homeIsUpper, upperTeam, lowerTeam, upperFromLabel, supportUpper, supportLower,
    resolveUpper, flatWaterRef,
    flatAdvice, recommend, recommendStats, REC_CASES,
    computeInjury, computeMatch, parseNumList, parseRosterList, markMap, parseValue, posClass, posFacOf,
    arbitrate, arbitrateLegacy, arbIsVeto, arbIsBad, arbIsOk, arbIsCaution, ARB_BRANCH,
    POS_CLASS_DEF, POS_FAC_DEF, POS_CLASS_NAME, INJURY_DEFAULTS,
    transferStatus, TRANSFER_WINDOWS,
    confName, confidence, confCalibration, shrunkLo,
    newRecord, recordToRow, recordToSummary, intentOf, sceneKey, computeStats,
  };
})(window);
