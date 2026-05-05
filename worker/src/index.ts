export interface Env {}

const API_BASE = "https://app.batrace.top";
const SEARCH_LIMIT = 20;
const VALID_SAMPLE_LIMITS = new Set([25, 50, 75, 100]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeSampleLimit(value: unknown) {
  const n = Number(value);
  return VALID_SAMPLE_LIMITS.has(n) ? n : 25;
}

function num(value: unknown, fallback: number | null = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value: unknown, fallback: number | null = null) {
  const n = num(value, null);
  return n === null ? fallback : Math.trunc(n);
}

function mean(values: Array<number | null | undefined>) {
  const arr = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function compact(name: string) {
  return String(name || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    let previous = dp[0];
    dp[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const old = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = old;
    }
  }

  return dp[b.length];
}

function similarity(a: string, b: string) {
  const x = compact(a);
  const y = compact(b);

  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.88;

  return 1 - Math.min(levenshtein(x, y) / Math.max(x.length, y.length, 1), 1);
}

async function cachedJson(url: string, ttlSeconds: number) {
  const cache = caches.default;
  const key = new Request(url);
  const cached = await cache.match(key);

  if (cached) {
    return cached.json();
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": "BA-Scout-Web-Single/0.2"
    }
  });

  if (!response.ok) {
    throw new Error(`BATrace API 请求失败：${response.status}`);
  }

  const data = await response.json();

  const cacheResponse = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlSeconds}`
    }
  });

  await cache.put(key, cacheResponse.clone());
  return data;
}

function searchPlayer(name: string) {
  return cachedJson(`${API_BASE}/api/players/search?q=${encodeURIComponent(name)}&limit=${SEARCH_LIMIT}`, 600);
}

function playerInfo(id: number) {
  return cachedJson(`${API_BASE}/api/players/info?stbid=${id}`, 600);
}

function playerAnalysis(id: number) {
  return cachedJson(`${API_BASE}/api/analysis/player?stbid=${id}`, 1800);
}

function extractCandidates(data: any) {
  const rows: any[] = [];

  function walk(obj: any) {
    if (!obj) return;

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }

    if (typeof obj !== "object") return;

    const id = int(obj?.id ?? obj?.stbid ?? obj?.playerId ?? obj?.steamId, null);
    const name = obj?.name ?? obj?.playerName ?? obj?.nickname ?? obj?.username;

    if (id !== null && name) {
      rows.push(obj);
      return;
    }

    for (const value of Object.values(obj)) {
      walk(value);
    }
  }

  walk(data);

  const seen = new Set<number>();

  return rows
    .map((player: any) => {
      const id = int(player?.id ?? player?.stbid ?? player?.playerId ?? player?.steamId, null);
      const name = String(player?.name ?? player?.playerName ?? player?.nickname ?? player?.username ?? "");

      if (id === null || !name || seen.has(id)) return null;

      seen.add(id);

      return {
        id,
        name,
        rating: num(player?.rating ?? player?.elo ?? player?.mmr, null),
        level: int(player?.level, null),
        raw: player
      };
    })
    .filter(Boolean);
}

function chooseCandidate(name: string, elo: number | null, candidates: any[]) {
  if (!candidates.length) {
    return { candidate: null, confidence: 0, matchStatus: "unmatched" };
  }

  const scored = candidates
    .map((candidate) => {
      let eloScore = 0.5;

      if (elo !== null && candidate.rating !== null) {
        eloScore = 1 - Math.min(Math.abs(elo - candidate.rating), 300) / 300;
      }

      return {
        candidate,
        score: 0.7 * similarity(name, candidate.name) + 0.3 * eloScore
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (compact(name) === compact(best.candidate.name)) {
    return { candidate: best.candidate, confidence: best.score, matchStatus: "exact" };
  }

  if (best.score >= 0.86) {
    return { candidate: best.candidate, confidence: best.score, matchStatus: "auto" };
  }

  if (best.score >= 0.7) {
    return { candidate: best.candidate, confidence: best.score, matchStatus: "uncertain" };
  }

  return { candidate: null, confidence: best.score, matchStatus: "unmatched" };
}

function trendPoints(analysis: any) {
  const points = analysis?.trend?.points;

  if (!Array.isArray(points)) return [];

  return points.slice().sort((a, b) => Number(a?.endTime ?? 0) - Number(b?.endTime ?? 0));
}

function recentPoints(analysis: any, limit: number) {
  const points = trendPoints(analysis);
  return points.length > limit ? points.slice(-limit) : points;
}

function buildRadar(points: any[]) {
  const avgKd = mean(points.map((point) => num(point?.kdRatio, null))) ?? 0;
  const avgObjective = mean(points.map((point) => num(point?.objectivesCaptured, null))) ?? 0;
  const avgKill = mean(points.map((point) => num(point?.destructionScore, null))) ?? 0;
  const avgLoss = mean(points.map((point) => num(point?.lossesScore, null))) ?? 0;
  const winRate = mean(points.map((point) => (point?.won ? 1 : 0))) ?? 0;

  const clamp = (value: number) => Math.max(0, Math.min(100, value));

  return [
    { subject: "胜率", value: clamp(winRate * 100) },
    { subject: "KD", value: clamp(avgKd * 40) },
    { subject: "占点", value: clamp(avgObjective * 25) },
    { subject: "击杀", value: clamp(avgKill / 50) },
    { subject: "生存", value: clamp(100 - avgLoss / 50) },
    { subject: "稳定", value: points.length ? 70 : 0 }
  ];
}

async function analyzePlayer(name: string, elo: number | null, sampleLimit: number) {
  const serverDataUtc = utcNow();
  const searchResult = await searchPlayer(name);
  const chosen = chooseCandidate(name, elo, extractCandidates(searchResult));

  if (!chosen.candidate) {
    const warnings = ["未匹配到 API 玩家，仅显示输入名称。"];

    return {
      serverDataUtc,
      player: {
        inputName: name,
        serverDataUtc,
        displayName: name,
        playerId: null,
        level: null,
        rating: elo,
        matchStatus: chosen.matchStatus,
        confidence: chosen.confidence,
        sampleLimit,
        trendSample: 0,
        winRate: null,
        avgKd: null,
        eloDelta: null,
        avgObjectives: null,
        avgDestruction: null,
        avgLosses: null,
        eloPoints: [],
        radar: buildRadar([]),
        tags: ["未匹配"],
        warnings
      },
      warnings
    };
  }

  const [info, analysis] = await Promise.all([
    playerInfo(chosen.candidate.id),
    playerAnalysis(chosen.candidate.id)
  ]);

  const points = recentPoints(analysis, sampleLimit);
  const firstRating = points.length ? num(points[0]?.ratingBefore, null) : null;
  const lastRating = points.length ? num(points[points.length - 1]?.ratingAfter, null) : null;

  const winRate = points.length ? mean(points.map((point) => (point?.won ? 1 : 0))) : null;
  const avgKd = mean(points.map((point) => num(point?.kdRatio, null)));
  const avgObjectives = mean(points.map((point) => num(point?.objectivesCaptured, null)));
  const avgDestruction = mean(points.map((point) => num(point?.destructionScore, null)));
  const avgLosses = mean(points.map((point) => num(point?.lossesScore, null)));

  const rating = num(info?.info?.rating ?? chosen.candidate.rating ?? elo, null);
  const level = int(info?.info?.level ?? chosen.candidate.level, null);

  const tags: string[] = [];

  if (rating !== null) {
    if (rating >= 1800) tags.push("高分玩家");
    else if (rating >= 1600) tags.push("较强");
    else if (rating < 1100) tags.push("低分");
  }

  if (winRate !== null) {
    if (winRate >= 0.65) tags.push("近期强势");
    else if (winRate <= 0.35) tags.push("近期低迷");
  }

  if (avgKd !== null && avgKd >= 1.4) {
    tags.push("高KD");
  }

  const warnings =
    points.length < sampleLimit
      ? [`最近对局不足 ${sampleLimit} 场，按 ${points.length} 场计算。`]
      : [];

  return {
    serverDataUtc,
    player: {
      inputName: name,
      serverDataUtc,
      displayName: chosen.candidate.name,
      playerId: chosen.candidate.id,
      level,
      rating,
      matchStatus: chosen.matchStatus,
      confidence: chosen.confidence,
      sampleLimit,
      trendSample: points.length,
      winRate,
      avgKd,
      eloDelta: firstRating !== null && lastRating !== null ? lastRating - firstRating : null,
      avgObjectives,
      avgDestruction,
      avgLosses,
      eloPoints: points.map((point, index) => ({
        x: index + 1,
        elo: num(point?.ratingAfter ?? point?.ratingBefore, 0) ?? 0
      })),
      radar: buildRadar(points),
      tags: tags.slice(0, 4),
      warnings
    },
    warnings
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/debug/search" && request.method === "GET") {
      const query = url.searchParams.get("q") || "";

      if (!query.trim()) {
        return json({ error: "请加 ?q=玩家名" }, 400);
      }

      const raw = await searchPlayer(query.trim());

      return json({
        query,
        raw,
        candidates: extractCandidates(raw)
      });
    }

    if (url.pathname === "/api/analyze-player" && request.method === "POST") {
      try {
        const body = await request.json<any>();
        const sampleLimit = normalizeSampleLimit(body?.sampleLimit);
        const name = String(body?.player?.name ?? "").trim();
        const elo = num(body?.player?.elo, null);

        if (!name) {
          return json({ error: "玩家 ID / 昵称不能为空" }, 400);
        }

        return json(await analyzePlayer(name, elo, sampleLimit));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    return json({ error: "Not Found" }, 404);
  }
};
