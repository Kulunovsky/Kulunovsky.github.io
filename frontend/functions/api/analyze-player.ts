const API_BASE = "https://app.batrace.top";
const SEARCH_LIMIT = 20;
const VALID_SAMPLE_LIMITS = new Set([25, 50, 75, 100]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
function utcNow() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function normalizeSampleLimit(v: unknown) { const n = Number(v); return VALID_SAMPLE_LIMITS.has(n) ? n : 25; }
function num(v: unknown, f: number | null = null) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function int(v: unknown, f: number | null = null) { const n = num(v, null); return n === null ? f : Math.trunc(n); }
function mean(values: Array<number | null | undefined>) { const a = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)); return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; }
function compact(s: string) { return String(s || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, ""); }
function lev(a: string, b: string) { const dp = Array.from({length:b.length+1},(_,i)=>i); for(let i=1;i<=a.length;i++){let p=dp[0];dp[0]=i;for(let j=1;j<=b.length;j++){const o=dp[j];dp[j]=Math.min(dp[j]+1,dp[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=o;}} return dp[b.length]; }
function sim(a: string, b: string) { const x=compact(a), y=compact(b); if(!x||!y) return 0; if(x===y) return 1; if(x.includes(y)||y.includes(x)) return .88; return 1-Math.min(lev(x,y)/Math.max(x.length,y.length,1),1); }

async function cachedJson(url: string, ttl: number) {
  const cache = caches.default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "BA-Scout-Pages/0.4" } });
    if (!res.ok) throw new Error(`BATrace API 请求失败：${res.status}`);
    const data = await res.json();
    await cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } }));
    return data;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error("第三方数据源响应超时，请稍后重试。");
    throw e;
  } finally { clearTimeout(timer); }
}

const searchPlayer = (name: string) => cachedJson(`${API_BASE}/api/players/search?q=${encodeURIComponent(name)}&limit=${SEARCH_LIMIT}`, 600);
const playerInfo = (id: number) => cachedJson(`${API_BASE}/api/players/info?stbid=${id}`, 600);
const playerAnalysis = (id: number) => cachedJson(`${API_BASE}/api/analysis/player?stbid=${id}`, 1800);
const matchAnalysis = (id: string) => cachedJson(`${API_BASE}/api/analysis/match?matchid=${encodeURIComponent(id)}`, 2592000);

function walkCandidates(data: any) {
  const rows: any[] = [];
  function walk(o: any) {
    if (!o) return;
    if (Array.isArray(o)) { for (const x of o) walk(x); return; }
    if (typeof o !== "object") return;
    const id = int(o?.id ?? o?.stbid ?? o?.playerId ?? o?.steamId, null);
    const name = o?.name ?? o?.playerName ?? o?.nickname ?? o?.username;
    if (id !== null && name) { rows.push(o); return; }
    for (const v of Object.values(o)) walk(v);
  }
  walk(data);
  const seen = new Set<number>();
  return rows.map((p:any)=> {
    const id = int(p?.id ?? p?.stbid ?? p?.playerId ?? p?.steamId, null);
    const name = String(p?.name ?? p?.playerName ?? p?.nickname ?? p?.username ?? "");
    if (id === null || !name || seen.has(id)) return null;
    seen.add(id);
    return { id, name, rating: num(p?.rating ?? p?.elo ?? p?.mmr, null), level: int(p?.level, null), raw: p };
  }).filter(Boolean);
}
function choose(name: string, elo: number | null, candidates: any[]) {
  if (!candidates.length) return { candidate: null, confidence: 0, matchStatus: "unmatched" };
  const scored = candidates.map((c:any)=> {
    let es = .5;
    if (elo !== null && c.rating !== null) es = 1 - Math.min(Math.abs(elo - c.rating), 300) / 300;
    return { c, score: .7 * sim(name, c.name) + .3 * es };
  }).sort((a,b)=>b.score-a.score);
  const b = scored[0];
  if (compact(name) === compact(b.c.name)) return { candidate: b.c, confidence: b.score, matchStatus: "exact" };
  if (b.score >= .86) return { candidate: b.c, confidence: b.score, matchStatus: "auto" };
  if (b.score >= .7) return { candidate: b.c, confidence: b.score, matchStatus: "uncertain" };
  return { candidate: null, confidence: b.score, matchStatus: "unmatched" };
}
function trendPoints(analysis:any){ const pts = analysis?.trend?.points; return Array.isArray(pts) ? pts.slice().sort((a,b)=>Number(a?.endTime??0)-Number(b?.endTime??0)) : []; }
function recentPoints(analysis:any, limit:number){ const pts = trendPoints(analysis); return pts.length > limit ? pts.slice(-limit) : pts; }
function extractMatchIds(info:any, analysis:any, limit:number) {
  const ids:string[] = [];
  if (Array.isArray(info?.last_fights_data)) ids.push(...info.last_fights_data.filter((x:any)=>x!=null).map(String));
  for (const p of trendPoints(analysis).slice().reverse()) if (p?.matchId != null) ids.push(String(p.matchId));
  const seen = new Set<string>(), out:string[] = [];
  for (const id of ids) { if (!seen.has(id)) { seen.add(id); out.push(id); } if (out.length >= limit) break; }
  return out;
}
async function fetchMatches(ids:string[]) {
  const res = await Promise.all(ids.map(async id => {
    try { return { status:"ok", data: await matchAnalysis(id) }; }
    catch(e:any){ const m = String(e?.message ?? e); return { status: m.includes("404") || m.toLowerCase().includes("not found") ? "404" : "failed", data:null }; }
  }));
  return { matches: res.filter(x=>x.status==="ok" && x.data).map(x=>x.data), notFound: res.filter(x=>x.status==="404").length, failed: res.filter(x=>x.status==="failed").length };
}
function findRow(arr:any, pid:number|null, name:string) {
  if (!Array.isArray(arr)) return null;
  for (const x of arr) if (x && pid !== null && int(x.playerId, null) === pid) return x;
  for (const x of arr) if (x && String(x.playerName ?? "").trim() === name.trim()) return x;
  return null;
}
function playerTeam(match:any,pid:number|null,name:string){ for(const path of [["mvpRanking"],["economy","players"],["unitComposition","byPlayer"],["damageContribution","teamA"],["damageContribution","teamB"]]){let o=match; for(const k of path) o=o?.[k]; const r=findRow(o,pid,name); if(r) return int(r.teamId,null);} return null; }
function mvpRank(match:any,pid:number|null,name:string){ const rows=Array.isArray(match?.mvpRanking)?match.mvpRanking.slice():[]; rows.sort((a:any,b:any)=>Number(b?.score??0)-Number(a?.score??0)); for(let i=0;i<rows.length;i++){const r=rows[i]; if((pid!==null&&int(r?.playerId,null)===pid)||String(r?.playerName??"").trim()===name.trim()) return i+1;} return null; }
function damageShareRank(match:any,pid:number|null,name:string,teamId:number|null){ const dc=match?.damageContribution??{}; const arrays=teamId===0?[dc.teamA]:teamId===1?[dc.teamB]:[dc.teamA,dc.teamB]; for(const arr of arrays){const rows=Array.isArray(arr)?arr.slice():[]; rows.sort((a:any,b:any)=>Number(b?.damageDealt??0)-Number(a?.damageDealt??0)); for(let i=0;i<rows.length;i++){const r=rows[i]; if((pid!==null&&int(r?.playerId,null)===pid)||String(r?.playerName??"").trim()===name.trim()){let p=num(r?.percentage,null); if(p!==null&&p>1)p/=100; return [p,i+1] as const;}}} return [null,null] as const; }
function playerCategories(match:any,pid:number|null,name:string){ const row=findRow(match?.unitComposition?.byPlayer,pid,name); return Array.isArray(row?.categories)?row.categories.filter((x:any)=>x&&typeof x==="object"):[]; }
function buildCategories(matches:any[],pid:number|null,name:string){ const agg:Record<string,{count:number,cost:number,damage:number}>={}; let total=0; const n=Math.max(matches.length,1); for(const m of matches){for(const c of playerCategories(m,pid,name)){const k=String(c.categoryKey??c.categoryId??"unknown"), count=num(c.count,0)??0, cost=num(c.totalCost,0)??0, dmg=num(c.totalDamage,0)??0; agg[k]??={count:0,cost:0,damage:0}; agg[k].count+=count; agg[k].cost+=cost; agg[k].damage+=dmg; total+=cost;}} return Object.entries(agg).map(([k,v])=>({categoryKey:k,countPerMatch:v.count/n,costPerMatch:v.cost/n,damagePerMatch:v.damage/n,costShare:total>0?v.cost/total:0})).sort((a,b)=>b.costPerMatch-a.costPerMatch).slice(0,12); }
function buildUnits(analysis:any){ const arr=Array.isArray(analysis?.highlightUnits)?analysis.highlightUnits:[]; return arr.map((u:any)=>({unitName:String(u?.unitName??"未知单位"),spawnCount:int(u?.spawnCount,0)??0,totalCost:num(u?.totalCost,0)??0,totalDamage:num(u?.totalDamage,0)??0,avgRoi:num(u?.avgRoi,null),categoryType:int(u?.categoryType,null)})).sort((a:any,b:any)=>b.totalDamage+b.totalCost-(a.totalDamage+a.totalCost)).slice(0,12); }
function buildMaps(analysis:any){ const arr=Array.isArray(analysis?.mapPerformance)?analysis.mapPerformance:[]; return arr.map((m:any)=>{let wr=num(m?.winRate,0)??0; if(wr>1)wr/=100; return {mapName:String(m?.mapName??`地图 ${m?.mapId??""}`),matchCount:int(m?.matchCount,0)??0,wins:int(m?.wins,0)??0,winRate:wr,avgKd:num(m?.avgKd,0)??0,avgDestructionScore:num(m?.avgDestructionScore,0)??0};}).sort((a:any,b:any)=>b.matchCount-a.matchCount).slice(0,10); }
function findKey(obj:any,key:string):any{ if(Array.isArray(obj)){for(const x of obj){const f=findKey(x,key); if(f!==undefined)return f;}} else if(obj&&typeof obj==="object"){ if(key in obj)return obj[key]; for(const v of Object.values(obj)){const f=findKey(v,key); if(f!==undefined)return f;}} return undefined; }
function statInfo(...sources:any[]){ for(const s of sources){const f=findKey(s,"statInfo"); if(f&&typeof f==="object"&&!Array.isArray(f))return f;} return {}; }
function kv(obj:any):Array<[string,number]>{ if(!obj)return[]; if(Array.isArray(obj))return obj.map((x:any)=>{const k=x?.key??x?.id??x?.name??x?.specId??x?.nationId??x?.categoryKey??x?.categoryId; const v=num(x?.value??x?.exp??x?.count??x?.totalCost??x?.percentage,null); return k!==undefined&&v!==null?[String(k),v] as [string,number]:null;}).filter(Boolean) as Array<[string,number]>; if(typeof obj==="object")return Object.entries(obj).map(([k,v])=>{const n=num(v,null); return n!==null?[k,n] as [string,number]:null;}).filter(Boolean) as Array<[string,number]>; return[]; }
function percentItems(obj:any, trans:(k:string)=>string, top:number){ const pairs=kv(obj); const total=pairs.reduce((s,[,v])=>s+Math.max(v,0),0)||1; return pairs.map(([k,v])=>({name:trans(k),rawKey:k,value:v,percentage:v/total})).sort((a,b)=>b.value-a.value).slice(0,top); }
const nationName=(k:string)=>({ "1":"俄罗斯", "2":"美国" } as Record<string,string>)[k] || `未知国家 ${k}`;
const specName=(k:string)=>`未知专精 ${k}`;
const specComboName=(k:string)=>String(k).replace(/-/g,"_").split("_").filter(Boolean).map(specName).join(" + ") || `未知专精组合 ${k}`;
function buildCategoryPrefs(analysis:any){ const arr=Array.isArray(analysis?.categoryPreferences)?analysis.categoryPreferences:[]; return arr.map((x:any)=>{let p=num(x?.percentage,0)??0; if(p>1)p/=100; const k=String(x?.categoryKey??x?.categoryId??"unknown"); return {name:k,rawKey:k,value:num(x?.totalCost,0)??0,percentage:p};}).sort((a:any,b:any)=>b.percentage-a.percentage).slice(0,10); }
function buildPrefs(analysis:any,info:any){ const st=statInfo(analysis,info), ps=analysis?.playStyle??{}; const axes=Array.isArray(ps?.axes)?ps.axes.map((a:any)=>({name:String(a?.label??a?.axis??"未知维度"),rawKey:String(a?.axis??""),value:num(a?.value,0)??0,percentage:(num(a?.value,0)??0)/100})):[]; return {categoryPreferences:buildCategoryPrefs(analysis),nationPreferences:percentItems(st?.nationExp,nationName,8),specPreferences:percentItems(st?.specExp,specName,10),specComboPreferences:percentItems(st?.combinedSpecsExp,specComboName,10),playStylePrimary:String(ps?.primaryStyle??""),playStyleAxes:axes.sort((a:any,b:any)=>b.value-a.value).slice(0,8)}; }
function longTerm(analysis:any,info:any){ const st=statInfo(analysis,info); const pick=(...keys:string[])=>{for(const k of keys){const v=num(st?.[k],null); if(v!==null)return v;} return 0;}; const pi=(...keys:string[])=>Math.trunc(pick(...keys)); const fights=pi("fightsCountRt","fightsCountCt","fightsCountSk"), wins=pi("winCountRt","winCountCt","winCountSk"), losses=pi("lossCountRt","lossCountCt","lossCountSk"), leave=pi("leaveCountRt","leaveCountCt","leaveCountSk"), kc=pick("unitsKilledCostRt","unitsKilledCostCt","unitsKilledCostSk"), lc=pick("unitsLostCostRt","unitsLostCostCt","unitsLostCostSk"), dur=pick("matchDurationTimeSecRt","matchDurationTimeSecCt","matchDurationTimeSecSk"), sta=pick("supplyPtsConsumedByAllies","supplyPtsConsumedByAlliesRt","supplyPtsConsumedByAlliesCt"), sfa=pick("supplyPtsConsumedFromAllies","supplyPtsConsumedFromAlliesRt","supplyPtsConsumedFromAlliesCt"); return {fights,wins,losses,winRate:fights>0?wins/fights:null,leaveCount:leave,leaveRate:fights>0?leave/fights:null,killedCost:kc,killedCount:pi("unitsKilledCountRt","unitsKilledCountCt","unitsKilledCountSk"),lostCost:lc,lostCount:pi("unitsLostCountRt","unitsLostCountCt","unitsLostCountSk"),economyRatio:lc>0?kc/lc:null,avgKilledCost:fights>0?kc/fights:null,avgLostCost:fights>0?lc/fights:null,avgDurationMin:fights>0?dur/fights/60:null,refundedCount:pi("unitsRefundedCount","unitsRefundedCountRt","unitsRefundedCountCt"),friendlyFireKillCount:pi("unitsKilledFriendlyFireCount","unitsKilledFriendlyFireCountRt","unitsKilledFriendlyFireCountCt"),friendlyFireLostCount:pi("unitsLostFriendlyFireCount","unitsLostFriendlyFireCountRt","unitsLostFriendlyFireCountCt"),selfDestructionCount:pi("unitsSelfDestructionCount","unitsSelfDestructionCountRt","unitsSelfDestructionCountCt"),zoneCapturedCount:pi("zoneCapturedCount","zoneCapturedCountRt","zoneCapturedCountCt"),supplyCapturedCount:pi("supplyCapturedCount","supplyCapturedCountRt","supplyCapturedCountCt"),supplyCapturedByEnemyCount:pi("supplyCapturedByEnemyCount","supplyCapturedByEnemyCountRt","supplyCapturedByEnemyCountCt"),supplyConsumed:pick("supplyPtsConsumed","supplyPtsConsumedRt","supplyPtsConsumedCt"),supplyToAllies:sta,supplyFromAllies:sfa,supplyNet:sta-sfa}; }
function mvpBreakdown(matches:any[],pid:number|null,name:string){ const b:Record<string,number[]>={}; for(const m of matches){const row=findRow(m?.mvpRanking,pid,name), br=row?.breakdown; if(!br||typeof br!=="object")continue; for(const [k,v] of Object.entries(br)){const n=num(v,null); if(n!==null){b[k]??=[]; b[k].push(n);}}} return Object.fromEntries(Object.entries(b).map(([k,v])=>[k,mean(v)??0]).sort((a,b)=>Number(b[1])-Number(a[1]))); }
function group(key:string){ const k=(key||"").toLowerCase(); if(["infantry","soldier","步兵"].some(x=>k.includes(x)))return"infantry"; if(["vehicle","tank","armor","载具","坦克","装甲"].some(x=>k.includes(x)))return"vehicle"; if(["support","artillery","支援","炮"].some(x=>k.includes(x)))return"support"; if(["aircraft","airplane","plane","jet","飞机"].some(x=>k.includes(x)))return"aircraft"; if(["helicopter","heli","直升机"].some(x=>k.includes(x)))return"helicopter"; return k||"unknown"; }
function teamObj(match:any,teamId:number|null){ const c=match?.teamComparison??{}, k=teamId===0?"teamATotals":teamId===1?"teamBTotals":null; return k?num(c?.[k]?.objectivesCaptured,null):null; }
function clamp(v:number){ return Math.max(0,Math.min(100,Number.isFinite(v)?v:0)); }
function radar(report:any,matches:any[],points:any[],analysis:any,info:any){ const cbg:Record<string,number>={}; let total=0; const objRat:number[]=[]; for(const m of matches){const tid=playerTeam(m,report.playerId,report.displayName); for(const c of playerCategories(m,report.playerId,report.displayName)){const g=group(String(c.categoryKey??c.categoryId??"unknown")), cost=num(c.totalCost,0)??0; cbg[g]=(cbg[g]??0)+cost; total+=cost;} const po=mean(points.map(p=>num(p?.objectivesCaptured,null))), to=teamObj(m,tid); if(po!==null&&to!==null&&to>0)objRat.push(Math.min(po/to,1));} const t=total||1, st=statInfo(analysis,info), sn=(num(st?.supplyPtsConsumedByAllies,0)??0)-(num(st?.supplyPtsConsumedFromAllies,0)??0); let hc=0, ac=0; for(const u of report.units??[]){if(!u.spawnCount)continue; const price=u.totalCost/Math.max(u.spawnCount,1); ac+=u.totalCost; const th=[9,10,15,16].includes(u.categoryType)?500:300; if(price>=th)hc+=u.totalCost;} return [{subject:"抗线",value:clamp(100*((cbg.infantry??0)+(cbg.vehicle??0))/t)},{subject:"支援",value:clamp(100*(cbg.support??0)/t)},{subject:"空军",value:clamp(100*((cbg.aircraft??0)+.5*(cbg.helicopter??0))/t)},{subject:"占点",value:clamp(100*(mean(objRat)??0))},{subject:"补给",value:clamp(50+sn/5000*50)},{subject:"精英",value:clamp(ac>0?100*hc/ac:0)}]; }
function tags(r:any){ const out:string[]=[]; if(r.rating!==null){if(r.rating>=1800)out.push("高分玩家");else if(r.rating>=1600)out.push("较强");else if(r.rating<1100)out.push("低分");} if(r.winRate!==null){if(r.winRate>=.65)out.push("近期强势");else if(r.winRate<=.35)out.push("近期低迷");} if(r.eloDelta!==null){if(r.eloDelta>=80)out.push("近期上分");else if(r.eloDelta<=-80)out.push("近期掉分");} if(r.avgKd!==null&&r.avgKd>=1.4)out.push("高KD"); if(r.avgRoi!==null&&r.avgRoi>=1.3)out.push("高交换"); if(r.avgMvpRank!==null&&r.avgMvpRank<=3)out.push("核心"); if(r.avgDamageShare!==null&&r.avgDamageShare>=.3)out.push("主力输出"); if(r.longTerm?.leaveRate!==null&&r.longTerm?.leaveRate>=.08)out.push("退局偏高"); if(r.longTerm?.economyRatio!==null&&r.longTerm?.economyRatio>=1.3)out.push("长期高交换"); if(r.longTerm?.fights>=300)out.push("老玩家"); return Array.from(new Set(out)).slice(0,4); }

function emptyReport(name:string,elo:number|null,limit:number,t:string,chosen:any,warnings:string[]){ return {inputName:name,serverDataUtc:t,displayName:name,playerId:null,level:null,rating:elo,matchStatus:chosen.matchStatus,confidence:chosen.confidence,sampleLimit:limit,trendSample:0,matchSample:0,winRate:null,avgKd:null,eloDelta:null,avgObjectives:null,avgDestruction:null,avgLosses:null,avgInvestment:null,avgRefunded:null,avgReturnValue:null,avgLossValue:null,avgRoi:null,avgMvpRank:null,avgDamageShare:null,avgDamageRank:null,eloPoints:[],radar:[],tags:["未匹配"],warnings,longTerm:longTerm({},{}),mvpBreakdown:{},categories:[],categoryPreferences:[],nationPreferences:[],specPreferences:[],specComboPreferences:[],playStylePrimary:"",playStyleAxes:[],units:[],maps:[],notFoundMatchCount:0,failedMatchCount:0}; }

async function analyzePlayer(name:string, elo:number|null, limit:number) {
  const serverDataUtc = utcNow();
  const sr = await searchPlayer(name);
  const chosen = choose(name, elo, walkCandidates(sr));
  if (!chosen.candidate) {
    const warnings = ["未匹配到 API 玩家，仅显示输入名称。"];
    return { serverDataUtc, player: emptyReport(name, elo, limit, serverDataUtc, chosen, warnings), warnings };
  }
  const [info, analysis] = await Promise.all([playerInfo(chosen.candidate.id), playerAnalysis(chosen.candidate.id)]);
  const points = recentPoints(analysis, limit);
  const ids = extractMatchIds(info, analysis, limit);
  const matchResult = await fetchMatches(ids);
  const matches = matchResult.matches.slice(0, limit);
  const pid = chosen.candidate.id, displayName = chosen.candidate.name;
  const first = points.length ? num(points[0]?.ratingBefore, null) : null, last = points.length ? num(points[points.length-1]?.ratingAfter, null) : null;
  const investments:Num[] = [], refunded:Num[] = [], returns:Num[] = [], lossVals:Num[] = [], rois:Num[] = [], ranks:Num[] = [], dmgShares:Num[] = [], dmgRanks:Num[] = [];
  for (const m of matches) {
    const eco = findRow(m?.economy?.players, pid, displayName);
    if (eco) { const inv=num(eco.investment,null), ref=num(eco.refunded,null); investments.push(inv); refunded.push(ref); returns.push(num(eco.returnValue,null)); rois.push(num(eco.roi,null)); if(inv!==null&&ref!==null)lossVals.push(inv-ref); }
    ranks.push(mvpRank(m,pid,displayName));
    const [ds,dr]=damageShareRank(m,pid,displayName,playerTeam(m,pid,displayName)); dmgShares.push(ds); dmgRanks.push(dr);
  }
  const prefs = buildPrefs(analysis, info), lt = longTerm(analysis, info), units = buildUnits(analysis);
  const report:any = {
    inputName:name, serverDataUtc, displayName, playerId:pid,
    level:int(info?.info?.level ?? chosen.candidate.level, null),
    rating:num(info?.info?.rating ?? chosen.candidate.rating ?? elo, null),
    matchStatus:chosen.matchStatus, confidence:chosen.confidence, sampleLimit:limit,
    trendSample:points.length, matchSample:matches.length,
    winRate:points.length?mean(points.map((p:any)=>p?.won?1:0)):null,
    avgKd:mean(points.map((p:any)=>num(p?.kdRatio,null))),
    eloDelta:first!==null&&last!==null?last-first:null,
    avgObjectives:mean(points.map((p:any)=>num(p?.objectivesCaptured,null))),
    avgDestruction:mean(points.map((p:any)=>num(p?.destructionScore,null))),
    avgLosses:mean(points.map((p:any)=>num(p?.lossesScore,null))),
    avgInvestment:mean(investments), avgRefunded:mean(refunded), avgReturnValue:mean(returns), avgLossValue:mean(lossVals), avgRoi:mean(rois), avgMvpRank:mean(ranks), avgDamageShare:mean(dmgShares), avgDamageRank:mean(dmgRanks),
    eloPoints:points.map((p:any,i:number)=>({x:i+1,elo:num(p?.ratingAfter??p?.ratingBefore,0)??0})),
    radar:[], tags:[], warnings:[], longTerm:lt,
    mvpBreakdown:mvpBreakdown(matches,pid,displayName), categories:buildCategories(matches,pid,displayName),
    categoryPreferences:prefs.categoryPreferences, nationPreferences:prefs.nationPreferences, specPreferences:prefs.specPreferences, specComboPreferences:prefs.specComboPreferences,
    playStylePrimary:prefs.playStylePrimary, playStyleAxes:prefs.playStyleAxes, units, maps:buildMaps(analysis),
    notFoundMatchCount:matchResult.notFound, failedMatchCount:matchResult.failed
  };
  if(points.length<limit)report.warnings.push(`最近对局不足 ${limit} 场，按 ${points.length} 场计算。`);
  if(matchResult.notFound)report.warnings.push(`有 ${matchResult.notFound} 场历史对局没有第三方详细数据（404），已跳过。`);
  if(matchResult.failed)report.warnings.push(`有 ${matchResult.failed} 场对局详情拉取失败，已跳过。`);
  report.radar = radar(report, matches, points, analysis, info);
  report.tags = tags(report);
  return { serverDataUtc, player: report, warnings: report.warnings };
}

type Num = number | null;

export async function onRequestPost(context:any) {
  try {
    const body = await context.request.json<any>();
    const limit = normalizeSampleLimit(body?.sampleLimit);
    const name = String(body?.player?.name ?? "").trim();
    const elo = num(body?.player?.elo, null);
    if (!name) return json({ error: "玩家 ID / 昵称不能为空" }, 400);
    return json(await analyzePlayer(name, elo, limit));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
