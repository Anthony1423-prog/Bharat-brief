const SLOTS = ["m", "a", "e"];
const H = { "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (url.pathname === "/api/health") return json({ ok: true, phase: 3 });
    if (url.pathname === "/api/editions/latest") {
      const slot = url.searchParams.get("slot");
      if (!SLOTS.includes(slot)) return json({ error: "slot must be m, a or e" }, 400);
      try {
        const ed = await env.DB.prepare("SELECT id,edition_date,slot,status,is_sample,published_at FROM editions WHERE slot=? AND status='published' ORDER BY edition_date DESC LIMIT 1").bind(slot).first();
        if (!ed) return json({ edition: null, stories: [], message: "No published edition yet." });
        const { results: stories } = await env.DB.prepare("SELECT g.*, es.is_update, es.update_note FROM edition_stories es JOIN story_groups g ON g.id=es.group_id WHERE es.edition_id=? ORDER BY es.rank").bind(ed.id).all();
        const { results: srcs } = await env.DB.prepare("SELECT ss.group_id, a.title, a.url, a.published_at, s.name AS source, s.type FROM story_sources ss JOIN articles a ON a.id=ss.article_id JOIN sources s ON s.id=a.source_id WHERE ss.group_id IN (SELECT group_id FROM edition_stories WHERE edition_id=?) ORDER BY a.published_at").bind(ed.id).all();
        for (const g of stories) g.sources = srcs.filter(x => x.group_id === g.id);
        const job = await env.DB.prepare("SELECT status,finished_at,sources_ok,sources_failed FROM job_runs WHERE status IN ('ok','failed') ORDER BY id DESC LIMIT 1").first();
        return json({ edition: ed, stories, job });
      } catch (e) {
        return json({ error: "database unavailable" }, 503);
      }
    }
    return json({ error: "not found" }, 404);
  },
  // Fetching now runs in GitHub Actions (scripts/ingest.mjs); this cron only logs a heartbeat.
  async scheduled(event, env) {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO job_runs(started_at,finished_at,status,error) VALUES(?,?,?,?)").bind(now, now, "heartbeat", "Worker cron; ingestion runs in GitHub Actions").run();
  },
};
