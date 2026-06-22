import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// The app calls window.claude.complete(prompt). Route that to our local
// Express proxy, which forwards to the (free) Gemini API. This keeps App.jsx
// identical to the Claude-artifact version — only the transport changes.
window.claude = {
  async complete(prompt) {
    const res = await fetch('/api/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `API error (${res.status})`);
    return data.text ?? '';
  },

  // Streaming variant: calls onChunk(fullTextSoFar) as deltas arrive, returns
  // the complete text. Used by the Chat tab for token-by-token replies.
  async stream(prompt, onChunk, signal) {
    const res = await fetch('/api/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Stream error (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        if (onChunk) onChunk(full);
      }
    } catch (e) {
      // Aborting once we have the full reply is expected — return what we have.
      if (e.name !== 'AbortError') throw e;
    }
    return full;
  },
};

createRoot(document.getElementById('root')).render(<App />);
