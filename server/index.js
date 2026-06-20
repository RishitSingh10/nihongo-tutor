import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '1mb' }));

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const PORT = process.env.PORT || 8787;

app.get('/api/health', async (_req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    res.json({ ok: true, model: MODEL, ollamaUp: true, installed: models });
  } catch {
    res.json({ ok: true, model: MODEL, ollamaUp: false, installed: [] });
  }
});

// App sends { prompt }, gets back { text }. We force JSON output via Ollama's
// format:"json" so the app's parser always receives valid JSON.
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
        options: { temperature: 0.7 },
      }),
    });

    if (!r.ok) {
      const body = await r.text();
      // Most common case: model not pulled yet.
      if (r.status === 404) {
        return res.status(502).json({
          error: `Model "${MODEL}" not found in Ollama. Run:  ollama pull ${MODEL}`,
        });
      }
      return res.status(502).json({ error: `Ollama error ${r.status}: ${body}` });
    }

    const data = await r.json();
    res.json({ text: data.response || '' });
  } catch (e) {
    res.status(503).json({
      error:
        'Could not reach Ollama at ' +
        OLLAMA +
        '. Is it running? (start it with: ollama serve). ' +
        (e.message || ''),
    });
  }
});

app.listen(PORT, () => {
  console.log(`[proxy] http://localhost:${PORT}  ->  Ollama ${OLLAMA}  model=${MODEL}`);
});
