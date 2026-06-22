import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const PORT = process.env.PORT || 8787;
// Optional CPU thread override (e.g. "2" or "4" — handy on hybrid P/E-core chips).
const NUM_THREAD = process.env.OLLAMA_NUM_THREAD ? Number(process.env.OLLAMA_NUM_THREAD) : undefined;
// Safety backstop so a misbehaving model can't generate forever. Generous enough
// not to truncate a normal reply or a 10-card deck (~400-600 tokens).
const NUM_PREDICT = process.env.OLLAMA_NUM_PREDICT ? Number(process.env.OLLAMA_NUM_PREDICT) : 1536;

function genOptions() {
  const o = { temperature: 0.7, num_predict: NUM_PREDICT };
  if (NUM_THREAD) o.num_thread = NUM_THREAD;
  return o;
}

app.get('/api/health', async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    const data = await r.json();
    res.json({ ok: true, model: MODEL, ollamaUp: true, installed: (data.models || []).map((m) => m.name) });
  } catch {
    res.json({ ok: true, model: MODEL, ollamaUp: false, installed: [] });
  }
});

// App sends { prompt }, gets back { text }. format:"json" guarantees parseable
// output; keep_alive:-1 pins the model in RAM so we don't pay reload per request.
app.post('/api/complete', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        format: 'json',
        keep_alive: -1,
        options: genOptions(),
      }),
    });

    if (!r.ok) {
      const body = await r.text();
      if (r.status === 404) {
        return res.status(502).json({ error: `Model "${MODEL}" not found in Ollama. Run:  ollama pull ${MODEL}` });
      }
      return res.status(502).json({ error: `Ollama error ${r.status}: ${body}` });
    }

    const data = await r.json();
    res.json({ text: data.response || '' });
  } catch (e) {
    res.status(503).json({
      error: 'Could not reach Ollama at ' + OLLAMA + '. Is it running? (start it with: ollama serve). ' + (e.message || ''),
    });
  }
});

// Streaming endpoint for the Chat tab. Streams plain text deltas (chunked) as
// the model generates. No format:"json" here — the chat prompt asks for a
// line-delimited format that the client parses progressively.
app.post('/api/stream', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  // If the client disconnects (e.g. the UI aborts once it has the full reply),
  // cancel the upstream Ollama request so it stops generating immediately.
  // Use res 'close' (fires on connection teardown) guarded by writableEnded, so
  // a normal end() doesn't trigger a spurious abort. (req 'close' fires as soon
  // as the request body is read, which would abort every stream instantly.)
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: true, keep_alive: -1, options: genOptions() }),
      signal: ac.signal,
    });
    if (!r.ok || !r.body) {
      res.status(502);
      return res.end('ERROR: ' + (await r.text().catch(() => `Ollama ${r.status}`)));
    }

    // Ollama streams newline-delimited JSON; forward only the .response deltas.
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.response) res.write(obj.response);
        } catch {
          /* ignore partial / non-JSON lines */
        }
      }
    }
    res.end();
  } catch (e) {
    if (e.name === 'AbortError') { try { res.end(); } catch {} return; }
    if (!res.headersSent) res.status(503).json({ error: 'Stream failed: ' + (e.message || '') });
    else try { res.end(); } catch {}
  }
});

// Warm-up: load the model into RAM (and pin it) the moment the server boots, so
// the user's FIRST real message doesn't eat the ~20s cold-start penalty.
async function warmUp() {
  try {
    await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: 'hi', stream: false, keep_alive: -1, options: { num_predict: 1 } }),
    });
    console.log(`[proxy] model ${MODEL} warmed up and pinned in RAM`);
  } catch (e) {
    console.log(`[proxy] warm-up skipped (Ollama not reachable yet): ${e.message}`);
  }
}

app.listen(PORT, () => {
  console.log(`[proxy] http://localhost:${PORT}  ->  Ollama ${OLLAMA}  model=${MODEL}`);
  warmUp();
});
