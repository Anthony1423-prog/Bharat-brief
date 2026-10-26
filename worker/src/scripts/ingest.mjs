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
const BUMP = /supreme court|parliament|\brbi\b|\bgdp\b|election commission|constitution|cabinet|ceasefire|budget/i;
const pickTopic = (t, geo) => { for (const [k, re] of TOPIC) if (re.test(t)) return k; return STATES.some(s => t.includes(s)) ? "states" : geo === "World" ? "world" : "other"; };
const tokens = t => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3));
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };

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
    const arts = await q("SELECT a.title,a.url,a.snippet,a.published_at,s.id sid,s.name,s.type,s.geography FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.group_id=? ORDER BY a.published_at", [gid]);
    const head = arts.find(a => a.type === "primary") || arts[0];
    const text = arts.map(a => a.title).join(" ");
    const srcs = new Set(arts.map(a => a.sid)), primary = arts.some(a => a.type === "primary");
    const topic = pickTopic(head.title, head.geography);
    const state = STATES.find(s => text.includes(s)) || null;
    let ev = primary ? "confirmed" : "developing";
    if (/alleg|accus|claims?\b|denies|disput/i.test(text)) ev = "allegation";
    else if (arts.every(a => /opinion|analysis|editorial|explained|comment/i.test(a.url))) ev = "analysis";
    let imp = 2 + (primary ? 1 : 0) + (srcs.size >= 2 ? 1 : 0) + (srcs.size >= 3 ? 0.5 : 0) + (BUMP.test(text) ? 0.5 : 0); imp = Math.min(5, imp);
    const reason = [primary && "official source", srcs.size >= 2 && `reported by ${srcs.size} sources`, BUMP.test(text) && "key institution or policy named"].filter(Boolean).join("; ") || "single report";
    const note = ev === "confirmed" ? "Based on an official announcement; not independently verified by this app." : ev === "allegation" ? "Contains allegations or disputed claims; see attributed sources." : "Based on available reports; details may change.";
    await q(`UPDATE story_groups SET headline=?,summary=?,topic=?,geography=?,state=?,exam_tags='[]',importance=?,importance_reason=?,evidence_status=?,uncertainty_notes=?,event_date=?,updated_at=?,ai_generated=0 WHERE id=?`,
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
    await q("DELETE FROM edition_stories WHERE edition_id=?", [eid]);
    let rank = 1;
    for (const r of ranked.slice(0, MAX_STORIES)) await q("INSERT INTO edition_stories(edition_id,group_id,rank,is_update,update_note) VALUES(?,?,?,?,?)",
      [eid, r.gid, rank++, r.isNew ? 0 : 1, r.isNew ? null : "New reports added since the last edition"]);
    await q("UPDATE editions SET status=?,published_at=? WHERE id=?", [ranked.length ? "published" : "empty", iso(), eid]);
  }
  await q("DELETE FROM source_fetches WHERE fetched_at < ?", [hoursAgo(24 * 30)]);
  await q("DELETE FROM articles WHERE retrieved_at < ?", [hoursAgo(24 * 90)]);
  await q("UPDATE job_runs SET finished_at=?,sources_ok=?,sources_failed=?,status=?,error=? WHERE id=?", [iso(), ok, failed, failed === SOURCES.length ? "failed" : "ok", errors.join(" | ").slice(0, 500) || null, run]);
  console.log(`done: ${ok} sources ok, ${failed} failed, ${ranked.length} stories`, errors);
} catch (e) {
  await q("UPDATE job_runs SET finished_at=?,sources_ok=?,sources_failed=?,status='failed',error=? WHERE id=?", [iso(), ok, failed, String(e.message).slice(0, 500), run]).catch(() => {});
  throw e;
}
