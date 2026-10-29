const http = require('http');
const PORT = process.env.PORT || 8080;

// Utilisation d'une Map en mémoire pour gérer plusieurs utilisateurs simultanément
// Clé: clientId, Valeur: { deviceCode, userCode, createdAt }
const sessions = new Map();

// Nettoyage de la mémoire toutes les 5 minutes (supprime les codes de plus de 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [clientId, session] of sessions.entries()) {
    if (now - session.createdAt > 10 * 60 * 1000) {
      sessions.delete(clientId);
    }
  }
}, 5 * 60 * 1000);

const send = (res, code, body) => { 
  res.writeHead(code, { 
    'Content-Type': 'application/json', 
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  }); 
  res.end(JSON.stringify(body)); 
};

const MOVIX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "Referer": "https://movix.dog/",
  "Content-Type": "application/json"
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(u.pathname);
  
  // En-têtes CORS pour les requêtes Preflight
  if (req.method === 'OPTIONS') { 
    res.writeHead(204, { 
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' 
    }); 
    return res.end(); 
  }

  // 1. Route Anti-Mise en Veille (cron-job.org)
  if (p === '/ping') {
    return send(res, 200, { status: 'alive', activeSessions: sessions.size, timestamp: new Date().toISOString() });
  }

  // 2. Route /codetv - Génère un code propre à CHAQUE client
  if (p === '/codetv') {
    // On récupère ou génère un ID unique pour l'appareil qui fait la demande
    let clientId = u.searchParams.get('clientId');
    if (!clientId) {
      clientId = 'client-' + Math.random().toString(36).substring(2, 11);
    }

    try {
      console.log(`[Auth TV] Demande d'un nouveau code unique pour le client : ${clientId}`);
      
      const resp = await fetch('https://api.movix.dog/api/tv/link/start', {
        method: 'POST',
        headers: MOVIX_HEADERS,
        body: JSON.stringify({ deviceName: "Movix TV App", clientId: clientId })
      });
      
      const data = await resp.json();

      if (data.userCode && data.deviceCode) {
        // Sauvegarde de la session spécifique à cet utilisateur
        sessions.set(clientId, {
          userCode: data.userCode,
          deviceCode: data.deviceCode,
          createdAt: Date.now()
        });

        return send(res, 200, { 
          code: data.userCode, 
          clientId: clientId 
        });
      }

      return send(res, 500, { error: 'Erreur lors de la génération du code par Movix' });
    } catch (err) {
      console.error('[Auth TV] Erreur /codetv :', err.message);
      return send(res, 500, { error: 'Impossible de contacter Movix' });
    }
  }

  // 3. Route /codetv/poll - Vérifie l'état de validation de CE client précis
  if (p === '/codetv/poll') {
    const clientId = u.searchParams.get('clientId');
    const session = sessions.get(clientId);

    if (!clientId || !session) {
      return send(res, 400, { error: 'Session non trouvée ou expirée' });
    }

    try {
      const resp = await fetch('https://api.movix.dog/api/tv/link/poll', {
        method: 'POST',
        headers: MOVIX_HEADERS,
        body: JSON.stringify({ deviceCode: session.deviceCode })
      });
      
      const text = await resp.text();
      
      // Si le code a été validé avec succès (token reçu), on nettoie la session de la mémoire
      if (resp.status === 200 && text.includes('token')) {
        console.log(`[Auth TV] Liaison réussie pour le client ${clientId} ! Nettoyage session.`);
        sessions.delete(clientId);
      }

      res.writeHead(resp.status, { 
        'Content-Type': 'application/json', 
        'Access-Control-Allow-Origin': '*' 
      });
      return res.end(text);
    } catch (err) {
      return send(res, 500, { error: 'Erreur réseau lors du polling' });
    }
  }

  // 4. Route /stream - Récupération des flux vidéo
  if (p === '/stream') {
    const q = u.searchParams;
    const id = q.get('tmdb');
    const type = q.get('type') || 'movie';
    const season = q.get('season');
    const episode = q.get('episode');

    if (!id) return send(res, 400, { error: 'ID TMDB manquant' });

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
            if (epData.langues[lang]?.length > 0) { 
              streamUrl = epData.langues[lang][0].url; 
              break; 
            }
          }
        }
      } else if (data.players) {
        for (const cat of ['Default', 'VFQ', 'VFF', 'VOSTFR']) {
          if (data.players[cat]?.length > 0) { 
            streamUrl = data.players[cat][0].url; 
            break; 
          }
        }
      }

      if (streamUrl) return send(res, 200, { url: streamUrl });
      return send(res, 404, { error: 'Aucune source disponible pour ce contenu' });
    } catch (err) {
      return send(res, 500, { error: 'Erreur lors de la récupération du flux Movix' });
    }
  }

  // Racine par défaut
  send(res, 200, { status: 'Movix TV Proxy API', version: '3.0.0', memoryLimit: '512MB Optimized' });

}).listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(` Server API Multi-Utilisateurs prêt sur le port ${PORT}`);
  console.log(`==================================================`);
});