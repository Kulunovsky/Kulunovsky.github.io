import { useEffect, useMemo, useState } from "react";
import {
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const BACKGROUND_INTERVAL_MS = 10_000;

type Num = number | null;

type Report = {
  inputName: string;
  serverDataUtc: string;
  displayName: string;
  playerId: number | null;
  level: number | null;
  rating: number | null;
  matchStatus: string;
  confidence: number;
  sampleLimit: number;
  trendSample: number;
  matchSample: number;
  winRate: Num;
  avgKd: Num;
  eloDelta: Num;
  avgObjectives: Num;
  avgDestruction: Num;
  avgLosses: Num;
  avgInvestment: Num;
  avgRefunded: Num;
  avgReturnValue: Num;
  avgLossValue: Num;
  avgRoi: Num;
  avgMvpRank: Num;
  avgDamageShare: Num;
  avgDamageRank: Num;
  eloPoints: Array<{ x: number; elo: number }>;
  radar: Array<{ subject: string; value: number }>;
  tags: string[];
  warnings: string[];
  longTerm: {
    fights: number;
    wins: number;
    losses: number;
    winRate: Num;
    leaveCount: number;
    leaveRate: Num;
    killedCost: number;
    killedCount: number;
    lostCost: number;
    lostCount: number;
    economyRatio: Num;
    avgKilledCost: Num;
    avgLostCost: Num;
    avgDurationMin: Num;
    refundedCount: number;
    friendlyFireKillCount: number;
    friendlyFireLostCount: number;
    selfDestructionCount: number;
    zoneCapturedCount: number;
    supplyCapturedCount: number;
    supplyCapturedByEnemyCount: number;
    supplyConsumed: number;
    supplyToAllies: number;
    supplyFromAllies: number;
    supplyNet: number;
  };
  mvpBreakdown: Record<string, number>;
  categories: Array<{ categoryKey: string; countPerMatch: number; costPerMatch: number; damagePerMatch: number; costShare: number }>;
  categoryPreferences: Array<{ name: string; rawKey: string; value: number; percentage: number }>;
  nationPreferences: Array<{ name: string; rawKey: string; value: number; percentage: number }>;
  specPreferences: Array<{ name: string; rawKey: string; value: number; percentage: number }>;
  specComboPreferences: Array<{ name: string; rawKey: string; value: number; percentage: number }>;
  playStylePrimary: string;
  playStyleAxes: Array<{ name: string; rawKey: string; value: number; percentage: number }>;
  units: Array<{ unitName: string; spawnCount: number; totalCost: number; totalDamage: number; avgRoi: Num; categoryType: Num }>;
  maps: Array<{ mapName: string; matchCount: number; wins: number; winRate: number; avgKd: number; avgDestructionScore: number }>;
  notFoundMatchCount: number;
  failedMatchCount: number;
};

function fmt(v: number | null | undefined, d = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "N/A";
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(d);
}

function pct(v: number | null | undefined) {
  return v === null || v === undefined || Number.isNaN(v) ? "N/A" : `${(v * 100).toFixed(1)}%`;
}

function statusText(s: string) {
  return ({ exact: "精确匹配", auto: "自动匹配", uncertain: "疑似匹配", unmatched: "未匹配" } as Record<string, string>)[s] || s;
}

function mvpName(k: string) {
  return ({ damage: "伤害贡献", destruction: "击杀经济", dlRatio: "损失交换比", efficiency: "效率", experience: "经验 / 成长", objectives: "占点贡献", supply: "补给贡献" } as Record<string, string>)[k] || k;
}

function catName(key: string) {
  const k = String(key || "").toLowerCase();
  if (k.includes("infantry") || k.includes("soldier")) return "步兵";
  if (k.includes("vehicle") || k.includes("tank") || k.includes("armor")) return "载具 / 装甲";
  if (k.includes("support") || k.includes("artillery") || k.includes("aa")) return "支援 / 火炮 / 防空";
  if (k.includes("aircraft") || k.includes("plane") || k.includes("jet")) return "固定翼飞机";
  if (k.includes("helicopter") || k.includes("heli")) return "直升机";
  if (k.includes("logistics") || k.includes("supply")) return "后勤 / 补给";
  if (k.includes("recon") || k.includes("scout")) return "侦察";
  return key || "未知类别";
}

function buildBackgroundCandidates() {
  const out: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const n = String(i).padStart(2, "0");
    for (const ext of ["jpg", "jpeg", "png", "webp"]) out.push(`/backgrounds/${n}.${ext}`);
  }
  return out;
}

function loadImage(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function useBg() {
  const candidates = useMemo(() => buildBackgroundCandidates(), []);
  const [arr, setArr] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let stop = false;
    Promise.all(candidates.map(loadImage)).then((loaded) => {
      if (stop) return;
      setArr(loaded.filter((x): x is string => Boolean(x)));
      setIdx(0);
    });
    return () => { stop = true; };
  }, [candidates]);

  useEffect(() => {
    if (arr.length <= 1) return;
    const t = window.setInterval(() => setIdx((x) => (x + 1) % arr.length), BACKGROUND_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [arr.length]);

  return arr.length ? arr[idx] : "";
}

function DataList({ children }: { children: React.ReactNode }) {
  return <ul className="data-list">{children}</ul>;
}

export default function App() {
  const [name, setName] = useState("");
  const [elo, setElo] = useState("");
  const [sampleLimit, setSampleLimit] = useState(25);
  const [opacity, setOpacity] = useState(60);
  const [report, setReport] = useState<Report | null>(null);
  const [msg, setMsg] = useState("准备就绪");
  const [loading, setLoading] = useState(false);
  const background = useBg();

  async function analyze() {
    const cleanName = name.trim();
    if (!cleanName) {
      setMsg("请输入玩家 ID / 昵称。");
      return;
    }

    setLoading(true);
    setMsg(`正在查询，目标样本 ${sampleLimit} 场...`);

    try {
      const res = await fetch(`${API_BASE}/api/analyze-player`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sampleLimit, player: { name: cleanName, elo: elo.trim() ? Number(elo) : null } })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setReport(data.player);
      setMsg("分析完成");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "分析失败");
    } finally {
      setLoading(false);
    }
  }

  const lt = report?.longTerm;

  return (
    <main className="app" style={{ ["--alpha" as string]: opacity / 100, backgroundImage: background ? `url(${background})` : undefined }}>
      <div className="mask">
        <header className="top">
          <div>
            <h1>BA Scout 单人查询</h1>
            <p>输入一个玩家 ID / 昵称和 ELO。</p>
          </div>
          <div className="settings">
            <label>样本
              <select value={sampleLimit} onChange={(e) => setSampleLimit(Number(e.target.value))}>
                <option value={25}>25</option><option value={50}>50</option><option value={75}>75</option><option value={100}>100</option>
              </select>
            </label>
            <label>透明度 {opacity}%
              <input type="range" min={20} max={80} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
            </label>
          </div>
        </header>

        <section className="panel">
          <h2>玩家查询</h2>
          <div className="form">
            <label>玩家 ID / 昵称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="输入玩家昵称" /></label>
            <label>ELO<input value={elo} onChange={(e) => setElo(e.target.value)} placeholder="例如 1650" /></label>
          </div>
          <div className="actions"><button disabled={loading} onClick={analyze}>{loading ? "查询中..." : "开始查询"}</button><span>{msg}</span></div>
        </section>

        {!report ? <section className="empty">输入玩家后点击“开始查询”。</section> : (
          <section className="result">
            <div className="hero">
              <div>
                <h2>{report.displayName}</h2>
                <p>ID：{report.playerId ?? "N/A"}　等级：{report.level ?? "?"}　ELO：{report.rating ? Math.round(report.rating) : "?"}</p>
                <p>{statusText(report.matchStatus)}　置信度 {report.confidence.toFixed(2)}</p>
              </div>
              <div className="tags">{report.tags.length ? report.tags.map((t) => <span key={t}>{t}</span>) : <span>数据不足</span>}</div>
            </div>

            <div className="stats">
              <div><b>样本</b><span>目标 {report.sampleLimit} / 趋势 {report.trendSample} / 详情 {report.matchSample}</span></div>
              <div><b>胜率</b><span>{pct(report.winRate)}</span></div>
              <div><b>KD</b><span>{fmt(report.avgKd, 2)}</span></div>
              <div><b>ELO 涨跌</b><span>{fmt(report.eloDelta, 0)}</span></div>
              <div><b>平均回报</b><span>{fmt(report.avgRoi, 2)}</span></div>
              <div><b>MVP 排名</b><span>{fmt(report.avgMvpRank, 2)}</span></div>
              <div><b>伤害贡献</b><span>{pct(report.avgDamageShare)}</span></div>
              <div><b>占点</b><span>{fmt(report.avgObjectives, 2)}</span></div>
            </div>

            <div className="charts">
              <div className="chart"><h3>ELO 变化折线图</h3><ResponsiveContainer width="100%" height={260}><LineChart data={report.eloPoints}><XAxis dataKey="x" /><YAxis domain={["dataMin - 20", "dataMax + 20"]} /><Tooltip /><Line dataKey="elo" strokeWidth={3} dot={false} /></LineChart></ResponsiveContainer></div>
              <div className="chart"><h3>玩家风格雷达图</h3><ResponsiveContainer width="100%" height={300}><RadarChart data={report.radar}><PolarGrid /><PolarAngleAxis dataKey="subject" /><Radar dataKey="value" fillOpacity={0.35} /><Tooltip /></RadarChart></ResponsiveContainer></div>
            </div>

            <div className="detail-grid">
              <section className="panel"><h3>近期表现</h3><p>胜率：{pct(report.winRate)}　平均 KD：{fmt(report.avgKd, 2)}　ELO 涨跌：{fmt(report.eloDelta, 0)}</p><p>平均击杀经济：{fmt(report.avgReturnValue, 0)}　平均损失经济：{fmt(report.avgLossValue, 0)}　平均投资回报率：{fmt(report.avgRoi, 2)}</p><p>平均占点数：{fmt(report.avgObjectives, 2)}　平均 MVP 排名：{fmt(report.avgMvpRank, 2)}</p><p>平均队伍伤害贡献：{pct(report.avgDamageShare)}　平均队内伤害排名：{fmt(report.avgDamageRank, 2)}</p></section>

              <section className="panel"><h3>长期累计表现</h3>{lt ? <><p>累计场次：{lt.fights}　长期胜率：{pct(lt.winRate)}　退局率：{pct(lt.leaveRate)}</p><p>长期击杀经济：{fmt(lt.killedCost, 0)}　长期损失经济：{fmt(lt.lostCost, 0)}　长期经济交换比：{fmt(lt.economyRatio, 2)}</p><p>平均每场击杀经济：{fmt(lt.avgKilledCost, 0)}　平均每场损失经济：{fmt(lt.avgLostCost, 0)}　平均对局时长：{fmt(lt.avgDurationMin, 1)} 分钟</p><p>累计击杀单位数：{lt.killedCount}　累计损失单位数：{lt.lostCount}</p></> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>单位管理与风险</h3>{lt ? <><p>单位回收次数：{lt.refundedCount}</p><p>友军误伤击杀次数：{lt.friendlyFireKillCount}</p><p>友军误伤损失次数：{lt.friendlyFireLostCount}</p><p>自毁单位次数：{lt.selfDestructionCount}</p></> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>占点与补给</h3>{lt ? <><p>累计占点次数：{lt.zoneCapturedCount}</p><p>累计占领补给点：{lt.supplyCapturedCount}</p><p>己方补给点被敌方占领次数：{lt.supplyCapturedByEnemyCount}</p><p>自身消耗补给：{fmt(lt.supplyConsumed, 0)}　给队友提供补给：{fmt(lt.supplyToAllies, 0)}</p><p>消耗队友补给：{fmt(lt.supplyFromAllies, 0)}　补给净贡献：{fmt(lt.supplyNet, 0)}</p></> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>MVP 贡献细分</h3>{Object.keys(report.mvpBreakdown).length ? <DataList>{Object.entries(report.mvpBreakdown).map(([k, v]) => <li key={k}>{mvpName(k)}：{fmt(v, 2)}</li>)}</DataList> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>最近对局兵种类别分析</h3>{report.categories.length ? <DataList>{report.categories.map((x) => <li key={x.categoryKey}>{catName(x.categoryKey)}：平均数量 {fmt(x.countPerMatch, 1)}，平均投入 {fmt(x.costPerMatch, 0)}，平均伤害 {fmt(x.damagePerMatch, 0)}，投入占比 {pct(x.costShare)}</li>)}</DataList> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>长期兵种偏好</h3>{report.categoryPreferences.length ? <DataList>{report.categoryPreferences.map((x) => <li key={x.rawKey}>{catName(x.name)}：投入 {fmt(x.value, 0)}，占比 {pct(x.percentage)}</li>)}</DataList> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>API 风格判断</h3><p>主要风格：{report.playStylePrimary || "无"}</p>{report.playStyleAxes.length ? <DataList>{report.playStyleAxes.map((x) => <li key={x.rawKey}>{x.name}：{fmt(x.value, 1)}</li>)}</DataList> : <p>无可用数据</p>}</section>

              <section className="panel triple-panel"><h3>国家 / 专精 / 组合偏好</h3><div className="triple-grid"><div><h4>国家偏好</h4>{report.nationPreferences.length ? <DataList>{report.nationPreferences.map((x) => <li key={x.rawKey}>{x.name}：{pct(x.percentage)}</li>)}</DataList> : <p>无</p>}</div><div><h4>专精偏好</h4>{report.specPreferences.length ? <DataList>{report.specPreferences.map((x) => <li key={x.rawKey}>{x.name}：{pct(x.percentage)}</li>)}</DataList> : <p>无</p>}</div><div><h4>常用组合</h4>{report.specComboPreferences.length ? <DataList>{report.specComboPreferences.map((x) => <li key={x.rawKey}>{x.name}：{pct(x.percentage)}</li>)}</DataList> : <p>无</p>}</div></div></section>

              <section className="panel"><h3>常用 / 高光单位</h3>{report.units.length ? <DataList>{report.units.map((u) => <li key={u.unitName}>{u.unitName}：出场 {u.spawnCount}，总花费 {fmt(u.totalCost, 0)}，总伤害 {fmt(u.totalDamage, 0)}，平均投资回报率 {fmt(u.avgRoi, 2)}</li>)}</DataList> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>地图表现</h3>{report.maps.length ? <DataList>{report.maps.map((m) => <li key={m.mapName}>{m.mapName}：场次 {m.matchCount}，胜率 {pct(m.winRate)}，KD {fmt(m.avgKd, 2)}，平均击杀分 {fmt(m.avgDestructionScore, 0)}</li>)}</DataList> : <p>无可用数据</p>}</section>

              <section className="panel"><h3>数据提示</h3>{report.warnings.length ? <DataList>{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</DataList> : <p>无</p>}</section>
            </div>

            <div className="server-time-space" aria-hidden="true"><br /><br /><br /><br /><br /></div>
            <div className="server-time">服务器数据时间：{report.serverDataUtc || "未知"} UTC</div>
          </section>
        )}

        <footer className="site-footer">
          <div>项目作者： kulunovsky</div>
          <div>数据源于第三方，实际数据以游戏为准</div>
        </footer>
      </div>
    </main>
  );
}
