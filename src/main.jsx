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
};

createRoot(document.getElementById('root')).render(<App />);
