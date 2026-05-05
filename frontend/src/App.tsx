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

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";
const BACKGROUND_INTERVAL_MS = 10_000;

type Point = { x: number; elo: number };
type RadarItem = { subject: string; value: number };

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
  winRate: number | null;
  avgKd: number | null;
  eloDelta: number | null;
  avgObjectives: number | null;
  avgDestruction: number | null;
  avgLosses: number | null;
  eloPoints: Point[];
  radar: RadarItem[];
  tags: string[];
  warnings: string[];
};

function fmt(v: number | null | undefined, d = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "N/A";
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(d);
}

function pct(v: number | null | undefined) {
  return v === null || v === undefined || Number.isNaN(v)
    ? "N/A"
    : `${(v * 100).toFixed(1)}%`;
}

function statusText(s: string) {
  return (
    {
      exact: "精确匹配",
      auto: "自动匹配",
      uncertain: "疑似匹配",
      unmatched: "未匹配"
    } as Record<string, string>
  )[s] || s;
}

function buildBackgroundCandidates() {
  const candidates: string[] = [];
  const exts = ["jpg", "jpeg", "png", "webp"];
  for (let i = 1; i <= 20; i += 1) {
    const num = String(i).padStart(2, "0");
    for (const ext of exts) {
      candidates.push(`/backgrounds/${num}.${ext}`);
    }
  }
  return candidates;
}

function loadImage(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function useBackgroundSlideshow() {
  const candidates = useMemo(() => buildBackgroundCandidates(), []);
  const [backgrounds, setBackgrounds] = useState<string[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    Promise.all(candidates.map(loadImage)).then((loaded) => {
      if (cancelled) return;
      const valid = loaded.filter((x): x is string => Boolean(x));
      setBackgrounds(valid);
      setIndex(0);
    });

    return () => {
      cancelled = true;
    };
  }, [candidates]);

  useEffect(() => {
    if (backgrounds.length <= 1) return;

    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % backgrounds.length);
    }, BACKGROUND_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [backgrounds.length]);

  return backgrounds.length ? backgrounds[index] : "";
}

export default function App() {
  const [name, setName] = useState("");
  const [elo, setElo] = useState("");
  const [sampleLimit, setSampleLimit] = useState(25);
  const [opacity, setOpacity] = useState(60);
  const [report, setReport] = useState<Report | null>(null);
  const [msg, setMsg] = useState("准备就绪");
  const [loading, setLoading] = useState(false);

  const background = useBackgroundSlideshow();

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
        body: JSON.stringify({
          sampleLimit,
          player: {
            name: cleanName,
            elo: elo.trim() ? Number(elo) : null
          }
        })
      });

      if (!res.ok) {
        throw new Error(await res.text());
      }

      const data = await res.json();
      setReport(data.player);
      setMsg("分析完成");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "分析失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className="app"
      style={{
        ["--alpha" as string]: opacity / 100,
        backgroundImage: background ? `url(${background})` : undefined
      }}
    >
      <div className="mask">
        <header className="top">
          <div>
            <h1>BA Scout 单人查询</h1>
            <p>输入一个玩家 ID / 昵称和可选 ELO。</p>
          </div>

          <div className="settings">
            <label>
              样本
              <select value={sampleLimit} onChange={(e) => setSampleLimit(Number(e.target.value))}>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={75}>75</option>
                <option value={100}>100</option>
              </select>
            </label>

            <label>
              透明度 {opacity}%
              <input
                type="range"
                min={20}
                max={80}
                value={opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
              />
            </label>
          </div>
        </header>

        <section className="panel">
          <h2>玩家查询</h2>
          <div className="form">
            <label>
              玩家 ID / 昵称
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="输入玩家昵称" />
            </label>
            <label>
              ELO，可不填
              <input value={elo} onChange={(e) => setElo(e.target.value)} placeholder="例如 1650" />
            </label>
          </div>
          <div className="actions">
            <button disabled={loading} onClick={analyze}>
              {loading ? "查询中..." : "开始查询"}
            </button>
            <span>{msg}</span>
          </div>
        </section>

        {!report ? (
          <section className="empty">输入玩家后点击“开始查询”。</section>
        ) : (
          <section className="result">
            <div className="hero">
              <div>
                <h2>{report.displayName}</h2>
                <p>
                  ID：{report.playerId ?? "N/A"}　等级：{report.level ?? "?"}　ELO：
                  {report.rating ? Math.round(report.rating) : "?"}
                </p>
                <p>
                  {statusText(report.matchStatus)}　置信度 {report.confidence.toFixed(2)}
                </p>
              </div>

              <div className="tags">
                {report.tags.length ? report.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>数据不足</span>}
              </div>
            </div>

            <div className="stats">
              <div>
                <b>样本</b>
                <span>
                  目标 {report.sampleLimit} / 实际 {report.trendSample}
                </span>
              </div>
              <div>
                <b>胜率</b>
                <span>{pct(report.winRate)}</span>
              </div>
              <div>
                <b>KD</b>
                <span>{fmt(report.avgKd, 2)}</span>
              </div>
              <div>
                <b>ELO 涨跌</b>
                <span>{fmt(report.eloDelta, 0)}</span>
              </div>
              <div>
                <b>占点</b>
                <span>{fmt(report.avgObjectives, 2)}</span>
              </div>
              <div>
                <b>击杀分</b>
                <span>{fmt(report.avgDestruction, 0)}</span>
              </div>
              <div>
                <b>损失分</b>
                <span>{fmt(report.avgLosses, 0)}</span>
              </div>
            </div>

            <div className="charts">
              <div className="chart">
                <h3>ELO 变化折线图</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={report.eloPoints}>
                    <XAxis dataKey="x" />
                    <YAxis domain={["dataMin - 20", "dataMax + 20"]} />
                    <Tooltip />
                    <Line dataKey="elo" strokeWidth={3} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="chart">
                <h3>基础雷达图</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <RadarChart data={report.radar}>
                    <PolarGrid />
                    <PolarAngleAxis dataKey="subject" />
                    <Radar dataKey="value" fillOpacity={0.35} />
                    <Tooltip />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {report.warnings.length ? (
              <div className="panel">
                <h3>数据提示</h3>
                <ul>
                  {report.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="server-time-space" aria-hidden="true">
              <br />
              <br />
              <br />
              <br />
              <br />
            </div>
            <div className="server-time">
              服务器数据时间：{report.serverDataUtc || "未知"} UTC
            </div>
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
