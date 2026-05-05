const API_BASE = "https://app.batrace.top";
const SEARCH_LIMIT = 20;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function num(value: unknown, fallback: number | null = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value: unknown, fallback: number | null = null) {
  const n = num(value, null);
  return n === null ? fallback : Math.trunc(n);
}

async function cachedJson(url: string, ttlSeconds: number) {
  const cache = caches.default;
  const key = new Request(url);
  const cached = await cache.match(key);

  if (cached) {
    return cached.json();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "BA-Scout-Pages/0.1"
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
  } finally {
    clearTimeout(timer);
  }
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

export async function onRequestGet(context: any) {
  const url = new URL(context.request.url);
  const q = url.searchParams.get("q") || "";

  if (!q.trim()) {
    return json({ error: "请加 ?q=玩家名" }, 400);
  }

  const raw = await cachedJson(
    `${API_BASE}/api/players/search?q=${encodeURIComponent(q.trim())}&limit=${SEARCH_LIMIT}`,
    600
  );

  return json({
    query: q,
    raw,
    candidates: extractCandidates(raw)
  });
}
