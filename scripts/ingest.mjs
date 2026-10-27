// Reads feeds, groups reports of the same event, publishes an edition to D1.
// Node 20+, no packages. No AI needed. Stores headline, short snippet and link only.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const { CF_ACCOUNT_ID: A, CF_API_TOKEN: T, CF_D1_ID: D } = process.env;
if (!A || !T || !D) throw new Error("Missing CF_ACCOUNT_ID / CF_API_TOKEN / CF_D1_ID");
const SOURCES = JSON.parse(readFileSync(new URL("./sources.json", import.meta.url)));
const MIN_IMPORTANCE = 2.5, MAX_STORIES = 25, WINDOW_H = 36;
const iso = (d = new Date()) => d.toISOString();
const hoursAgo = h => iso(new Date(Date.now() - h * 3600e3));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function q(sql, params = [], tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/d1/database/${D}/query`, {
        method: "POST", headers: { Authorization: `Bearer ${T}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params }) });
      const j = await r.json();
      if (j.success) return j.result[0].results || [];
      throw new Error(JSON.stringify(j.errors));
    } catch (e) { if (i === tries) throw new Error("D1 query failed: " + e.message); await sleep(500 * i * i); }
  }
}

// ---- feed parsing ----
const strip = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ");
const clean = s => strip(strip(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")).replace(/\s+/g, " ").trim();
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, "i")); return m ? clean(m[1]) : ""; };
const toIso = s => { const d = new Date(s); return s && !isNaN(d) ? d.toISOString() : null; };
function parse(xml) {
  const items = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return items.slice(0, 30).map(it => {
    let url = tag(it, "link");
    if (!url) { const m = it.match(/<link[^>]*href="([^"]+)"/i); url = m ? m[1] : ""; }
    return { title: tag(it, "title"), url: normUrl(url), snippet: (tag(it, "description") || tag(it, "summary")).slice(0, 300),
      published: toIso(tag(it, "pubDate") || tag(it, "published") || tag(it, "updated")) };
  }).filter(x => x.title && /^https?:\/\//.test(x.url));
}
function normUrl(u) { try { const x = new URL(u.trim()); x.hash = ""; [...x.searchParams.keys()].filter(k => /^utm_|^fbclid|^gclid/.test(k)).forEach(k => x.searchParams.delete(k)); return x.toString(); } catch { return u; } }
const hid = s => createHash("sha1").update(s).digest("hex").slice(0, 16);

// ---- classification (rules, no AI) ----
const TOPIC = [
  ["polity", /parliament|lok sabha|rajya sabha|supreme court|high court|constitution|cabinet|governor|tribunal|verdict|ordinance/i],
  ["elec", /election|bypoll|ballot|voter|election commission|poll panel/i],
  ["econ", /\brbi\b|repo rate|inflation|\bgdp\b|budget|\bgst\b|tax|export|import|trade|rupee|sensex|unemployment|infrastructure|bank|railway/i],
  ["sec", /defence|\barmy\b|\bnavy\b|air force|border|terror|diplomat|\bmea\b|foreign minister|internal security/i],
  ["env", /climate|heatwave|flood|cyclone|monsoon|earthquake|disease|outbreak|pollution|energy|solar|health|disaster/i],
  ["sci", /isro|space|satellite|artificial intelligence|\bai\b|semiconductor|technology|rocket/i],
  ["world", /ukraine|russia|gaza|israel|united nations|nato|white house|european union|iran|ceasefire|\bwar\b/i]];
const STATES = ["Bihar","Kerala","Uttar Pradesh","Maharashtra","Tamil Nadu","West Bengal"];
const ROUTINE = /auction|money market operations|variable rate|reverse repo|treasury bill|ways and means|overseas direct investment|weekly statistical|liquidity|\bvrr\b|\bvrrr\b/i;
const BUMP = /supreme court|parliament|\brbi\b|\bgdp\b|election commission|constitution|cabinet|ceasefire|budget/i;
const pickTopic = (t, geo, hint) => { for (const [k, re] of TOPIC) if (re.test(t)) return k; return STATES.some(s => t.includes(s)) ? "states" : hint === "economy" ? "econ" : geo === "World" ? "world" : "other"; };
const tokens = t => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3));
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

// ---- optional AI summaries (Gemini free tier). Off unless GEMINI_API_KEY is set. ----
let GEM_MODEL = process.env.GEMINI_MODEL || "";
const GEM_KEY = process.env.GEMINI_API_KEY, MAX_AI = +(process.env.MAX_AI_PER_RUN || 15);
// If GEMINI_MODEL is not set, ask Google which Flash-Lite model this key can use (newest stable first).
async function pickModel() {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": GEM_KEY }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("could not list Gemini models, HTTP " + r.status + " (check the key)");
  const ms = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /flash-lite/i.test(m.name));
  const ver = m => +((m.name.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  ms.sort((a, b) => (/preview|exp/i.test(a.name) - /preview|exp/i.test(b.name)) || ver(b) - ver(a));
  if (!ms.length) throw new Error("no Flash-Lite model available to this key");
  return ms[0].name.replace(/^models\//, "");
}
async function gemini(prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEM_MODEL}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": GEM_KEY, "content-type": "application/json" }, signal: AbortSignal.timeout(40000),
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 900 } }) });
  if (r.status === 429 || r.status === 403) throw Object.assign(new Error("quota or permission HTTP " + r.status), { stop: true });
  if (r.status === 400 || r.status === 404) throw Object.assign(new Error("bad request HTTP " + r.status + " - check GEMINI_MODEL / key"), { stop: true });
  if (!r.ok) throw new Error("Gemini HTTP " + r.status);
  const j = await r.json();
  return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
}
const PROMPT = arts => `You summarise Indian and world news for exam revision. Use ONLY the sources below. Do not add facts, names, numbers or dates that are not in them. Do not predict. If the sources are too thin, say so.
Attribute allegations to who made them. If sources disagree, say so.
Return JSON only: {"summary": string (2-3 plain sentences, max 500 chars), "why_it_matters": string or null (1-2 sentences of general significance supported by the sources, else null), "what_to_watch": string or null (only if a next step is stated in the sources, else null), "uncertainty_notes": string or null, "key_claims": [{"claim": string, "source_ids": [ids taken from the sources below]}]}
SOURCES: ${JSON.stringify(arts)}`;
export function validate(o, ids) {
  if (!o || typeof o.summary !== "string" || o.summary.length < 20 || o.summary.length > 700) return "bad summary";
  if (!Array.isArray(o.key_claims) || !o.key_claims.length) return "no claims";
  for (const c of o.key_claims) if (!c || !c.claim || !Array.isArray(c.source_ids) || !c.source_ids.length || !c.source_ids.every(i => ids.has(i))) return "claim without a valid source id";
  for (const k of ["why_it_matters", "what_to_watch", "uncertainty_notes"]) if (o[k] != null && (typeof o[k] !== "string" || o[k].length > 400)) return "bad " + k;
  return null;
}

// ---- main ----
const started = iso();
const run = (await q("INSERT INTO job_runs(started_at,status) VALUES(?,?) RETURNING id", [started, "running"]))[0].id;
let ok = 0, failed = 0; const errors = [];
try {
  for (const s of SOURCES) await q(`INSERT INTO sources(id,name,domain,type,geography,topics,feed_url,enabled,notes) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,domain=excluded.domain,type=excluded.type,geography=excluded.geography,topics=excluded.topics,feed_url=excluded.feed_url,enabled=excluded.enabled,notes=excluded.notes`,
    [s.id, s.name, s.domain, s.type, s.geography, s.topics, s.feed_url, s.enabled, s.notes]);

  const fetched = [];
  for (const s of SOURCES.filter(x => x.enabled)) {
    try {
      const r = await fetch(s.feed_url, { headers: { "User-Agent": "BharatBriefBot/1.0 (educational; headlines+links only)" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const items = parse(await r.text());
      if (!items.length) throw new Error("no items parsed");
      items.forEach(i => fetched.push({ ...i, source: s }));
      ok++; await q("INSERT INTO source_fetches(source_id,fetched_at,ok,item_count) VALUES(?,?,1,?)", [s.id, iso(), items.length]);
    } catch (e) {
      failed++; errors.push(`${s.id}: ${e.message}`);
      await q("INSERT INTO source_fetches(source_id,fetched_at,ok,item_count,error) VALUES(?,?,0,0,?)", [s.id, iso(), String(e.message).slice(0, 200)]);
    }
  }

  const known = new Set((await q("SELECT id FROM articles WHERE retrieved_at > ?", [hoursAgo(96)])).map(r => r.id));
  const groups = (await q("SELECT id,headline FROM story_groups WHERE updated_at > ?", [hoursAgo(72)])).map(g => ({ id: g.id, tok: tokens(g.headline) }));
  const touched = new Map(); // groupId -> {isNew}
  const cutoff = hoursAgo(WINDOW_H);
  for (const it of fetched) {
    const id = hid(it.url);
    if (known.has(id) || (it.published && it.published < cutoff)) continue;
    known.add(id);
    const tok = tokens(it.title);
    let best = null, bs = 0;
    for (const g of groups) { const sc = jac(tok, g.tok); if (sc > bs) { bs = sc; best = g; } }
    let gid, isNew = false;
    if (best && bs >= 0.5) gid = best.id;
    else { gid = "g_" + id; isNew = true; groups.push({ id: gid, tok });
      await q("INSERT INTO story_groups(id,headline,first_seen_at,updated_at) VALUES(?,?,?,?)", [gid, it.title, iso(), iso()]); }
    await q("INSERT OR IGNORE INTO articles(id,source_id,url,title,snippet,published_at,retrieved_at,group_id) VALUES(?,?,?,?,?,?,?,?)",
      [id, it.source.id, it.url, it.title, it.snippet, it.published, iso(), gid]);
    await q("INSERT OR IGNORE INTO story_sources(group_id,article_id) VALUES(?,?)", [gid, id]);
    const prev = touched.get(gid); touched.set(gid, { isNew: prev ? prev.isNew : isNew });
  }

  const ranked = [];
  for (const [gid, meta] of touched) {
    const arts = await q("SELECT a.title,a.url,a.snippet,a.published_at,s.id sid,s.name,s.type,s.geography,s.topics hint FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.group_id=? ORDER BY a.published_at", [gid]);
    const head = arts.find(a => a.type === "primary") || arts[0];
    const text = arts.map(a => a.title).join(" ");
    const srcs = new Set(arts.map(a => a.sid)), primary = arts.some(a => a.type === "primary");
    const topic = pickTopic(head.title, head.geography, head.hint);
    const state = STATES.find(s => text.includes(s)) || null;
    let ev = primary ? "confirmed" : "developing";
    if (/alleg|accus|claims?\b|denies|disput/i.test(text)) ev = "allegation";
    else if (arts.every(a => /opinion|analysis|editorial|explained|comment/i.test(a.url))) ev = "analysis";
    let imp = 2 + (primary ? 1 : 0) + (srcs.size >= 2 ? 1 : 0) + (srcs.size >= 3 ? 0.5 : 0) + (BUMP.test(text) ? 0.5 : 0); const routine = ROUTINE.test(text) && srcs.size < 2; if (routine) imp -= 1; imp = Math.min(5, Math.max(0, imp));
    const reason = [primary && "official source", srcs.size >= 2 && `reported by ${srcs.size} sources`, BUMP.test(text) && "key institution or policy named", routine && "routine release (ranked lower)"].filter(Boolean).join("; ") || "single report";
    const note = ev === "confirmed" ? "Based on an official announcement; not independently verified by this app." : ev === "allegation" ? "Contains allegations or disputed claims; see attributed sources." : "Based on available reports; details may change.";
    await q(`UPDATE story_groups SET headline=?,summary=?,topic=?,geography=?,state=?,exam_tags='[]',importance=?,importance_reason=?,evidence_status=?,uncertainty_notes=?,event_date=?,updated_at=?,ai_generated=0,why_it_matters=NULL,what_to_watch=NULL,claims_json=NULL WHERE id=?`,
      [head.title, (head.snippet || "").slice(0, 240) || null, topic, head.geography, state, imp, reason, ev, note, head.published_at ? head.published_at.slice(0, 10) : null, iso(), gid]);
    if (imp >= MIN_IMPORTANCE) ranked.push({ gid, imp, isNew: meta.isNew });
  }
  ranked.sort((a, b) => b.imp - a.imp);

  const ist = new Date(Date.now() + 5.5 * 3600e3), hr = ist.getUTCHours();
  const slot = hr < 10 ? "m" : hr < 16 ? "a" : "e", date = ist.toISOString().slice(0, 10), eid = `${date}_${slot}`;
  const prior = (await q("SELECT status FROM editions WHERE id=?", [eid]))[0];
  if (prior && prior.status === "published" && !ranked.length) errors.push("edition already published; nothing new to add");
  else {
    await q(`INSERT INTO editions(id,edition_date,slot,status,is_sample,started_at) VALUES(?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET status='running',started_at=excluded.started_at`, [eid, date, slot, "running", started]);
    // Merge, never replace: a re-run of the same slot adds stories and re-ranks, so earlier stories are not lost.
    for (const r of ranked.slice(0, MAX_STORIES)) await q("INSERT OR IGNORE INTO edition_stories(edition_id,group_id,rank,is_update,update_note) VALUES(?,?,99,?,?)",
      [eid, r.gid, r.isNew ? 0 : 1, r.isNew ? null : "New reports added since the last edition"]);
    await q("UPDATE edition_stories SET rank=(SELECT x.r FROM (SELECT es.group_id gid, ROW_NUMBER() OVER (ORDER BY g.importance DESC, g.updated_at DESC) r FROM edition_stories es JOIN story_groups g ON g.id=es.group_id WHERE es.edition_id=?1) x WHERE x.gid=edition_stories.group_id) WHERE edition_id=?1", [eid]);
    await q("DELETE FROM edition_stories WHERE edition_id=? AND rank>?", [eid, MAX_STORIES]);
    await q("UPDATE editions SET status=?,published_at=? WHERE id=?", [ranked.length ? "published" : "empty", iso(), eid]);
  }
  if (GEM_KEY) {
    let paused = "";
    if (!GEM_MODEL) { try { GEM_MODEL = await pickModel(); console.log("AI model:", GEM_MODEL); } catch (e) { paused = e.message; } }
    const eid2 = `${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}_${(h => h < 10 ? "m" : h < 16 ? "a" : "e")(new Date(Date.now() + 5.5 * 3600e3).getUTCHours())}`;
    const todo = await q("SELECT g.id,g.uncertainty_notes,g.claims_json FROM edition_stories es JOIN story_groups g ON g.id=es.group_id WHERE es.edition_id=? AND g.ai_generated=0 AND IFNULL(g.claims_json,'') NOT LIKE '%\"ai_attempts\":2%' ORDER BY es.rank LIMIT ?", [eid2, MAX_AI]);
    for (const t of paused ? [] : todo) {
      const arts = await q("SELECT a.id,s.name AS source,a.title,a.snippet FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.group_id=? ORDER BY a.published_at LIMIT 6", [t.id]);
      const ids = new Set(arts.map(a => a.id)); let done = false, why = "";
      for (let n = 0; n < 2 && !done; n++) {
        try {
          const o = JSON.parse(await gemini(PROMPT(arts))); why = validate(o, ids);
          if (!why) {
            const note = [t.uncertainty_notes, o.uncertainty_notes].filter(Boolean).join(" ");
            await q("UPDATE story_groups SET summary=?,why_it_matters=?,what_to_watch=?,uncertainty_notes=?,claims_json=?,ai_generated=1 WHERE id=?",
              [o.summary, o.why_it_matters || null, o.what_to_watch || null, note, JSON.stringify(o.key_claims), t.id]); done = true;
          }
        } catch (e) { why = e.message; if (e.stop) { paused = e.message; break; } }
        await sleep(7000);
      }
      if (paused) break;
      if (!done) { let prev = 0; try { prev = JSON.parse(t.claims_json || "{}").ai_attempts || 0; } catch {} await q("UPDATE story_groups SET claims_json=? WHERE id=?", [JSON.stringify({ ai_attempts: prev + 1, last: why }), t.id]); }
      await sleep(7000);
    }
    if (paused) errors.push("AI paused (" + paused + "); showing sourced headlines without AI summaries");
  }
  await q("DELETE FROM source_fetches WHERE fetched_at < ?", [hoursAgo(24 * 30)]);
  await q("DELETE FROM articles WHERE retrieved_at < ?", [hoursAgo(24 * 90)]);
  await q("UPDATE job_runs SET finished_at=?,sources_ok=?,sources_failed=?,status=?,error=? WHERE id=?", [iso(), ok, failed, failed === SOURCES.length ? "failed" : "ok", errors.join(" | ").slice(0, 500) || null, run]);
  console.log(`done: ${ok} sources ok, ${failed} failed, ${ranked.length} stories`, errors);
} catch (e) {
  await q("UPDATE job_runs SET finished_at=?,sources_ok=?,sources_failed=?,status='failed',error=? WHERE id=?", [iso(), ok, failed, String(e.message).slice(0, 500), run]).catch(() => {});
  throw e;
}
