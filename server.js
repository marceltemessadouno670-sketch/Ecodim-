const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ecodime2024';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ecodime-secret-2024';
const FIREBASE_URL = 'https://ecodim-jmt-default-rtdb.firebaseio.com';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── FIREBASE HELPERS ──
async function fbGet(path) {
  try {
    const url = `${FIREBASE_URL}/${path}.json${FIREBASE_SECRET ? '?auth=' + FIREBASE_SECRET : ''}`;
    const r = await fetch(url);
    return await r.json();
  } catch(e) { return null; }
}

async function fbSet(path, data) {
  try {
    const url = `${FIREBASE_URL}/${path}.json${FIREBASE_SECRET ? '?auth=' + FIREBASE_SECRET : ''}`;
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await r.json();
  } catch(e) { return null; }
}

async function fbUpdate(path, data) {
  try {
    const url = `${FIREBASE_URL}/${path}.json${FIREBASE_SECRET ? '?auth=' + FIREBASE_SECRET : ''}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await r.json();
  } catch(e) { return null; }
}

// ── PAGE PRINCIPALE ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── INSCRIPTION ──
app.post('/api/register', async (req, res) => {
  const { prenom, nom, pays, ville, eglise, avatar } = req.body;
  if (!prenom) return res.json({ success: false, message: 'Le prénom est obligatoire' });

  // Vérifier doublon dans Firebase
  const users = await fbGet('users') || {};
  const existing = Object.values(users).find(u =>
    u.prenom?.toLowerCase() === prenom.toLowerCase() &&
    (u.nom||'').toLowerCase() === (nom||'').toLowerCase()
  );
  if (existing) return res.json({ success: false, message: 'Ce nom existe déjà ! Connecte-toi.' });

  const id = 'u' + Date.now();
  const newUser = {
    id, prenom, nom: nom||'', pays: pays||'', ville: ville||'',
    eglise: eglise||'', avatar: avatar||'😇',
    xp: 0, coins: 100, storiesDone: [], quizDone: 0,
    unlockedAvatars: [],
    registeredAt: new Date().toISOString(),
    lastActive: new Date().toISOString()
  };

  await fbSet(`users/${id}`, newUser);
  
  // Log activité
  await fbUpdate(`logs/${Date.now()}`, {
    name: prenom + ' ' + nom,
    action: "s'est inscrit(e)",
    xp: 0, time: new Date().toISOString()
  });

  req.session.userId = id;
  req.session.prenom = prenom;
  res.json({ success: true, user: newUser });
});

// ── CONNEXION ──
app.post('/api/login', async (req, res) => {
  const { prenom } = req.body;
  if (!prenom) return res.json({ success: false, message: 'Entre ton prénom' });

  const users = await fbGet('users') || {};
  const user = Object.values(users).find(u =>
    u.prenom?.toLowerCase() === prenom.toLowerCase()
  );
  if (!user) return res.json({ success: false, message: 'Prénom introuvable ! Inscris-toi.' });

  await fbUpdate(`users/${user.id}`, { lastActive: new Date().toISOString() });
  req.session.userId = user.id;
  req.session.prenom = user.prenom;
  res.json({ success: true, user });
});

// ── SESSION ──
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const user = await fbGet(`users/${req.session.userId}`);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user });
});

// ── PROGRESSION ──
app.post('/api/progress', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ success: false });
  const { xp, coins, storiesDone, storyCompleted, unlockedAvatars, avatar } = req.body;
  
  const updates = { lastActive: new Date().toISOString() };
  if (xp !== undefined) updates.xp = xp;
  if (coins !== undefined) updates.coins = coins;
  if (storiesDone) updates.storiesDone = storiesDone;
  if (unlockedAvatars) updates.unlockedAvatars = unlockedAvatars;
  if (avatar) updates.avatar = avatar;

  await fbUpdate(`users/${req.session.userId}`, updates);

  if (storyCompleted) {
    await fbUpdate(`logs/${Date.now()}`, {
      name: req.session.prenom,
      action: 'a terminé : ' + storyCompleted,
      xp: 200, time: new Date().toISOString()
    });
    const stats = await fbGet('stats') || {};
    await fbSet('stats', { ...stats, storiesPlayed: (stats.storiesPlayed||0)+1 });
  }
  res.json({ success: true });
});

// ── QUIZ DONE ──
app.post('/api/quiz-done', async (req, res) => {
  if (!req.session.userId) return res.json({ success: false });
  const { score } = req.body;
  const stats = await fbGet('stats') || {};
  await fbSet('stats', { ...stats, quizDone: (stats.quizDone||0)+1 });
  await fbUpdate(`logs/${Date.now()}`, {
    name: req.session.prenom,
    action: `a complété un Quiz ${score}/5`,
    xp: score*30, time: new Date().toISOString()
  });
  res.json({ success: true });
});

// ── IA ──
app.post('/api/chat', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non connecté' });
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'IA non configurée' });
  const { messages, system } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: system||'', messages })
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ text: data.content?.[0]?.text || '' });
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── ADMIN LOGIN ──
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return setTimeout(() => res.json({ success: false, message: 'Mot de passe incorrect' }), 1000);
  }
  req.session.isAdmin = true;
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// ── DONNÉES ADMIN ──
app.get('/api/admin/data', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ success: false });
  
  const usersObj = await fbGet('users') || {};
  const logsObj = await fbGet('logs') || {};
  const stats = await fbGet('stats') || {};
  
  const users = Object.values(usersObj);
  const logs = Object.values(logsObj).sort((a,b) => new Date(b.time) - new Date(a.time)).slice(0,50);
  const countries = new Set(users.map(u => u.pays).filter(p => p)).size;

  res.json({
    stats: {
      totalUsers: users.length,
      storiesPlayed: stats.storiesPlayed||0,
      quizDone: stats.quizDone||0,
      countries
    },
    users, logs
  });
});

app.post('/api/admin/content', async (req, res) => {
  if (!req.session.isAdmin) return res.status(401).json({ success: false });
  const { title } = req.body;
  if (!title) return res.json({ success: false });
  await fbUpdate(`logs/${Date.now()}`, {
    name: 'Admin', action: 'a publié : ' + title,
    xp: 0, time: new Date().toISOString()
  });
  res.json({ success: true });
});

app.post('/api/admin/generate-quiz', async (req, res) => {
  if (!req.session.isAdmin || !ANTHROPIC_API_KEY) return res.json({ success: false });
  const { theme, difficulty } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5', max_tokens: 1024,
        messages: [{ role: 'user', content: `Génère une question de quiz biblique sur "${theme}" pour des enfants (${difficulty}). Format:\nQUESTION: [question]\nA: [option]\nB: [option]\nC: [option]\nD: [option]\nREPONSE: [lettre]\nEXPLICATION: [1-2 phrases]\nEn français.` }]
      })
    });
    const data = await r.json();
    res.json({ success: true, text: data.content?.[0]?.text || '' });
  } catch(e) { res.status(500).json({ success: false }); }
});

app.listen(PORT, () => {
  console.log(`✅ Ecodime Server sur port ${PORT}`);
  console.log(`🔑 API Key: ${ANTHROPIC_API_KEY ? '✅' : '❌ Manquante'}`);
  console.log(`🔥 Firebase: ${FIREBASE_URL}`);
});
