const http = require('http');
const PORT = process.env.PORT || 8080;

const send = (res, code, body) => { 
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); 
  res.end(JSON.stringify(body)); 
};

// Cache pour la liaison TV (gère les 9 minutes de validité)
let currentDeviceCode = null;
let currentUserCode = null;
let lastCodeFetchTime = 0;
const CODE_LIFETIME = 8 * 60 * 1000; 

const MOVIX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Referer": "https://movix.dog/",
  "Content-Type": "application/json"
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(u.pathname);
  
  console.log(`[API Request] ${req.method} -> ${p}`);

  if (req.method === 'OPTIONS') { 
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); 
    return res.end(); 
  }

  // 1. Route pour obtenir le code TV
  if (p === '/codetv') {
    const now = Date.now();
    if (currentUserCode && currentDeviceCode && (now - lastCodeFetchTime < CODE_LIFETIME)) {
      return send(res, 200, { code: currentUserCode });
    }

    try {
      const resp = await fetch('https://api.movix.dog/api/tv/link/start', {
        method: 'POST',
        headers: MOVIX_HEADERS,
        body: JSON.stringify({ deviceName: "Movix TV Tizen", clientId: "movix-tv-app" })
      });
      const data = await resp.json();

      if (data.error === 'rate_limited' && currentUserCode) {
        return send(res, 200, { code: currentUserCode });
      }

      if (data.userCode && data.deviceCode) {
        currentUserCode = data.userCode;
        currentDeviceCode = data.deviceCode;
        lastCodeFetchTime = now;
        return send(res, 200, { code: data.userCode });
      }
      return send(res, 500, { error: 'Erreur Movix' });
    } catch (err) {
      if (currentUserCode) return send(res, 200, { code: currentUserCode });
      return send(res, 500, { error: 'Impossible de contacter Movix' });
    }
  }

  // 2. Route pour le polling du token
  if (p === '/codetv/poll') {
    if (!currentDeviceCode) return send(res, 400, { error: 'Aucun code actif' });
    try {
      const resp = await fetch('https://api.movix.dog/api/tv/link/poll', {
        method: 'POST',
        headers: MOVIX_HEADERS,
        body: JSON.stringify({ deviceCode: currentDeviceCode })
      });
      const text = await resp.text();
      res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(text);
    } catch (err) {
      return send(res, 500, { error: 'Erreur réseau' });
    }
  }

  // 3. Route pour récupérer les flux vidéo
  if (p === '/stream') {
    const q = u.searchParams, id = q.get('tmdb'), type = q.get('type') || 'movie', season = q.get('season'), episode = q.get('episode');
    let url = `https://api.movix.dog/api/fstream/${type}/${id}`;
    if (type === 'tv' && season && episode) {
      url = `https://api.movix.dog/api/fstream/tv/${id}/season/${season}?episode=${episode}`;
    }
    try {
      const resp = await fetch(url, { headers: { 'Referer': 'https://movix.dog/' } });
      const data = await resp.json();
      let streamUrl = null;

      if (type === 'tv' && data.episodes) {
        const epData = data.episodes[String(episode)] || data.episodes[episode];
        if (epData && epData.langues) {
          for (const lang of ['VF', 'VOSTFR', 'Default']) {
            if (epData.langues[lang]?.length > 0) { streamUrl = epData.langues[lang][0].url; break; }
          }
        }
      } else if (data.players) {
        for (const cat of ['Default', 'VFQ', 'VFF', 'VOSTFR']) {
          if (data.players[cat]?.length > 0) { streamUrl = data.players[cat][0].url; break; }
        }
      }

      if (streamUrl) return send(res, 200, { url: streamUrl });
      return send(res, 404, { error: 'Aucun média trouvé' });
    } catch (err) {
      return send(res, 500, { error: 'Erreur flux Movix' });
    }
  }

  // Si on tape sur la racine du serveur distant, il répond juste qu'il est en ligne
  send(res, 200, { status: 'Movix TV Backend Online' });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`API Backend opérationnelle sur le port ${PORT}`);
});