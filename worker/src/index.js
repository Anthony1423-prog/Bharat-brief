const SLOTS = ["m", "a", "e"];
const H = { "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (url.pathname === "/api/health") return json({ ok: true, phase: 2, live_news: false });
    if (url.pathname === "/api/editions/latest") {
      const slot = url.searchParams.get("slot");
      if (!SLOTS.includes(slot)) return json({ error: "slot must be m, a or e" }, 400);
      try {
        const ed = await env.DB.prepare("SELECT id,edition_date,slot,status,is_sample,published_at FROM editions WHERE slot=? AND status='published' ORDER BY edition_date DESC LIMIT 1").bind(slot).first();
        if (!ed) return json({ edition: null, stories: [], message: "No published edition yet." });
        const { results } = await env.DB.prepare("SELECT g.* FROM edition_stories es JOIN story_groups g ON g.id=es.group_id WHERE es.edition_id=? ORDER BY es.rank").bind(ed.id).all();
        return json({ edition: ed, stories: results });
      } catch (e) {
        return json({ error: "database unavailable" }, 503);
      }
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(event, env) {
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO job_runs(started_at,finished_at,status,error) VALUES(?,?,?,?)").bind(now, now, "skipped", "Phase 2: ingestion not built yet").run();
  },
};
