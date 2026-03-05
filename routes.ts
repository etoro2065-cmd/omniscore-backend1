import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";

const FLASH_HOST = "flashscore4.p.rapidapi.com";
const FLASH_KEY = process.env.RAPIDAPI_KEY || "";
if (!FLASH_KEY) {
  console.warn("WARNING: RAPIDAPI_KEY environment variable is not set. API requests will fail.");
}
const FLASH_HEADERS = {
  "x-rapidapi-host": FLASH_HOST,
  "x-rapidapi-key": FLASH_KEY,
};
const BASE = "https://flashscore4.p.rapidapi.com/api/flashscore/v2";

const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL: Record<string, number> = {
  live: 60_000,
  list: 300_000,
  details: 300_000,
  summary: 300_000,
  stats: 300_000,
  lineups: 600_000,
  standings: 600_000,
  matchids: 600_000,
};

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MATCH_ID_REGEX = /^[a-zA-Z0-9_-]{1,40}$/;
const STANDINGS_TYPES = new Set(["overall", "home", "away"]);

function sanitizeString(input: string, maxLen = 100): string {
  return input.replace(/[^\w\s.,:;()[\]{}\-+/=@#$%^&*!?~`'"<>]/g, "").slice(0, maxLen);
}

function validateDate(date: unknown): string | null {
  if (typeof date !== "string") return null;
  const trimmed = date.trim();
  if (!DATE_REGEX.test(trimmed)) return null;
  const parts = trimmed.split("-");
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return trimmed;
}

function validateMatchId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!MATCH_ID_REGEX.test(trimmed)) return null;
  return trimmed;
}

function validateStandingsType(type: unknown): string {
  if (typeof type !== "string") return "overall";
  const trimmed = type.trim().toLowerCase();
  return STANDINGS_TYPES.has(trimmed) ? trimmed : "overall";
}

let rateLimitedUntil = 0;

async function fetchWithRetry(url: string): Promise<globalThis.Response> {
  const now = Date.now();
  if (now < rateLimitedUntil) {
    return new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 });
  }
  const response = await fetch(url, { headers: FLASH_HEADERS });
  if (response.status === 429) {
    rateLimitedUntil = now + 30_000;
  }
  return response;
}

function getCached(key: string, ttlKey: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = CACHE_TTL[ttlKey] || 60_000;
  if (Date.now() - entry.ts > ttl) {
    return null;
  }
  return entry.data;
}

function getStaleCached(key: string): any | null {
  const entry = cache.get(key);
  return entry ? entry.data : null;
}

function setCache(key: string, data: any) {
  cache.set(key, { data, ts: Date.now() });
}

function flashProxy(path: string, requiredParams: string[] = [], ttlKey = "details") {
  return async (req: Request, res: Response) => {
    try {
      for (const p of requiredParams) {
        if (!req.query[p]) {
          return res.status(400).json({ error: `${p} parameter is required` });
        }
        if (p === "match_id" && !validateMatchId(req.query[p])) {
          return res.status(400).json({ error: "Invalid match_id format" });
        }
      }
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") {
          sanitized[k] = sanitizeString(v);
        }
      }
      const qs = new URLSearchParams(sanitized).toString();
      const url = `${BASE}${path}${qs ? `?${qs}` : ""}`;
      const cached = getCached(url, ttlKey);
      if (cached) return res.json(cached);
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        const stale = cache.get(url);
        if (stale) return res.json(stale.data);
        return res.status(response.status).json({ error: `Failed to fetch ${path}` });
      }
      const data = await response.json();
      setCache(url, data);
      return res.json(data);
    } catch (error) {
      console.error(`Error fetching ${path}:`, error);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/matches/live", async (_req: Request, res: Response) => {
    try {
      const url = `${BASE}/matches/live?sport_id=1&timezone=Europe%2FBerlin`;
      const cached = getCached(url, "live");
      if (cached) return res.json(cached);
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        const stale = cache.get(url);
        if (stale) return res.json(stale.data);
        return res.status(response.status).json({ error: "Failed to fetch live matches" });
      }
      const data = await response.json();
      setCache(url, data);
      return res.json(data);
    } catch (error) {
      console.error("Error fetching live matches:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/matches/by-date", async (req: Request, res: Response) => {
    try {
      const date = validateDate(req.query.date);
      if (!date) return res.status(400).json({ error: "Invalid date parameter. Use YYYY-MM-DD format." });
      const url = `${BASE}/matches/list-by-date?sport_id=1&timezone=Europe%2FBerlin&date=${date}`;
      const cached = getCached(url, "list");
      if (cached) return res.json(cached);
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        const stale = cache.get(url);
        if (stale) return res.json(stale.data);
        return res.status(response.status).json({ error: "Failed to fetch matches" });
      }
      const data = await response.json();
      setCache(url, data);
      return res.json(data);
    } catch (error) {
      console.error("Error fetching matches by date:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/matches/details", flashProxy("/matches/details", ["match_id"]));
  app.get("/api/matches/summary", async (req: Request, res: Response) => {
    try {
      const matchId = validateMatchId(req.query.match_id);
      if (!matchId) return res.status(400).json({ error: "Invalid or missing match_id" });
      const url = `${BASE}/matches/match/summary?match_id=${matchId}`;
      const cached = getCached(url, "summary");
      if (cached) return res.json(cached);
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        const stale = cache.get(url);
        if (stale) return res.json(stale.data);
        return res.status(response.status).json({ error: "Failed to fetch summary" });
      }
      const raw: any[] = await response.json();
      if (!Array.isArray(raw)) return res.json([]);
      const events = raw.map((evt: any) => {
        const goalPlayer = evt.players?.find((p: any) => p.type === "Goal");
        const assistPlayer = evt.players?.find((p: any) => p.type === "Assistance");
        const yellowPlayer = evt.players?.find((p: any) => p.type === "Yellow Card");
        const redPlayer = evt.players?.find((p: any) => p.type === "Red Card");
        const subOut = evt.players?.find((p: any) => p.type === "Substitution - Out");
        const subIn = evt.players?.find((p: any) => p.type === "Substitution - In");
        let type = "other";
        let player = "";
        let assist: string | undefined;
        let detail: string | undefined;
        if (goalPlayer) {
          type = "goal";
          player = goalPlayer.name;
          if (assistPlayer) assist = assistPlayer.name;
        } else if (redPlayer) {
          type = "redcard";
          player = redPlayer.name;
          if (redPlayer.sub_type) detail = redPlayer.sub_type;
        } else if (yellowPlayer) {
          type = "yellowcard";
          player = yellowPlayer.name;
          if (yellowPlayer.sub_type) detail = yellowPlayer.sub_type;
        } else if (subOut && subIn) {
          type = "substitution";
          player = subIn.name;
          assist = subOut.name;
        }
        return {
          time: evt.minutes,
          type,
          team: evt.team,
          player,
          assist,
          detail,
        };
      });
      setCache(url, events);
      return res.json(events);
    } catch (error) {
      console.error("Error fetching summary:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
  app.get("/api/matches/stats", flashProxy("/matches/match/stats", ["match_id"], "stats"));
  app.get("/api/matches/lineups", flashProxy("/matches/match/lineups", ["match_id"], "lineups"));
  app.get("/api/matches/standings", async (req: Request, res: Response) => {
    try {
      const matchId = validateMatchId(req.query.match_id);
      if (!matchId) return res.status(400).json({ error: "Invalid or missing match_id" });
      const type = validateStandingsType(req.query.type);
      const url = `${BASE}/matches/standings?type=${type}&match_id=${matchId}`;
      const cached = getCached(url, "standings");
      if (cached) return res.json(cached);
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        const stale = cache.get(url);
        if (stale) return res.json(stale.data);
        return res.status(response.status).json({ error: "Failed to fetch standings" });
      }
      const data = await response.json();
      setCache(url, data);
      return res.json(data);
    } catch (error) {
      console.error("Error fetching standings:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/ads/interstitial", (_req: Request, res: Response) => {
    const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta charset="utf-8">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6962063655587926" crossorigin="anonymous"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0A0E17;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
.ad-container{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px}
.ad-unit{width:100%;max-width:400px;min-height:300px;display:flex;align-items:center;justify-content:center}
</style>
</head><body>
<div class="ad-container">
<div class="ad-unit">
<ins class="adsbygoogle"
  style="display:inline-block;width:300px;height:250px"
  data-ad-client="ca-pub-6962063655587926"
  data-ad-slot="8058495249"></ins>
<script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>
</div>
</div>
</body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  app.get("/api/leagues/match-ids", async (_req: Request, res: Response) => {
    try {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const url = `${BASE}/matches/list-by-date?sport_id=1&timezone=Europe%2FBerlin&date=${dateStr}`;
      const cachedResult = getCached("matchids-" + dateStr, "matchids");
      if (cachedResult) return res.json(cachedResult);
      const response = await fetchWithRetry(url);
      if (!response.ok) {
        const stale = cache.get("matchids-" + dateStr);
        if (stale) return res.json(stale.data);
        return res.status(response.status).json({ error: "Failed to fetch matches" });
      }
      const data: any[] = await response.json();
      const targetLeagues: Record<string, string[]> = {
        "Premier League (England)": ["ENGLAND: Premier League"],
        "La Liga (Spain)": ["SPAIN: LaLiga"],
        "Serie A (Italy)": ["ITALY: Serie A"],
        "Bundesliga (Germany)": ["GERMANY: Bundesliga"],
        "Ligue 1 (France)": ["FRANCE: Ligue 1"],
        "Botola Pro (Morocco)": ["MOROCCO: Botola Pro"],
        "Premiership (Scotland)": ["SCOTLAND: Premiership"],
        "Premier League (Egypt)": ["EGYPT: Premier League"],
        "UEFA Champions League": ["EUROPE: Champions League", "EUROPE: UEFA Champions League"],
        "UEFA Europa League": ["EUROPE: Europa League", "EUROPE: UEFA Europa League"],
        "FIFA World Cup 2026": ["WORLD: World Cup", "WORLD: FIFA World Cup", "WORLD: FIFA World Cup 2026"],
      };
      const result: { label: string; matchId: string }[] = [];
      for (const [label, names] of Object.entries(targetLeagues)) {
        for (const tournament of data) {
          if (names.some((n) => tournament.name === n) && tournament.matches?.length > 0) {
            result.push({ label, matchId: tournament.matches[0].match_id });
            break;
          }
        }
      }
      setCache("matchids-" + dateStr, result);
      return res.json(result);
    } catch (error) {
      console.error("Error fetching league match IDs:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
