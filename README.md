const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');
const admin = require('firebase-admin');

// Initialiser Firebase Admin SDK
let serviceAccount;
try {
  serviceAccount = require('./firebase-credentials.json');
} catch(e) {
  console.warn('⚠️ firebase-credentials.json manquant. Les routes Firebase Admin seront désactivées.');
}
if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://ecodim-jmt-default-rtdb.firebaseio.com'
  });
}
const db = serviceAccount ? admin.database() : null;

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ecodime2024';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ecodime-secret-key-change-in-prod';

// ══════════════════════════════════════
// MIDDLEWARES
// ══════════════════════════════════════
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ══════════════════════════════════════
// FONCTIONS D'ACCÈS FIREBASE (admin)
// ══════════════════════════════════════
async function getAllUsers() {
  if (!db) return [];
  const snapshot = await db.ref('users').once('value');
  const users = snapshot.val();
  if (!users) return [];
  return Object.entries(users).map(([id, data]) => ({ id, ...data }));
}

// ══════════════════════════════════════
// ROUTES PUBLIQUES
// ══════════════════════════════════════
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── IA CLAUDE ──
app.post('/api/chat', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'IA non configurée' });
  }
  const { messages, system } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: system || '',
        messages
      })
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json({ text: data.content?.[0]?.text || '' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════
// ROUTES ADMIN
// ══════════════════════════════════════
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    setTimeout(() => {
      res.json({ success: false, message: 'Mot de passe incorrect' });
    }, 1000);
    return;
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

app.get('/api/admin/data', requireAdmin, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Firebase Admin non configuré' });
  const users = await getAllUsers();
  const totalUsers = users.length;
  const countries = new Set(users.map(u => u.pays).filter(Boolean)).size;
  
  let stats = { storiesPlayed: 0, quizDone: 0 };
  const statsSnapshot = await db.ref('stats').once('value');
  if (statsSnapshot.val()) stats = statsSnapshot.val();
  
  let logs = [];
  const logsSnapshot = await db.ref('activityLogs').orderByKey().limitToLast(50).once('value');
  if (logsSnapshot.val()) logs = Object.values(logsSnapshot.val()).reverse();
  
  res.json({
    stats: {
      totalUsers,
      storiesPlayed: stats.storiesPlayed || 0,
      quizDone: stats.quizDone || 0,
      countries
    },
    users: users.map(u => ({
      id: u.id,
      prenom: u.prenom,
      nom: u.nom,
      pays: u.pays,
      ville: u.ville,
      eglise: u.eglise,
      xp: u.xp || 0,
      coins: u.coins || 0,
      storiesDone: u.storiesDone || [],
      quizDone: u.quizDone || 0,
      registeredAt: u.registeredAt || u.createdAt,
      lastActive: u.lastActive
    })),
    logs: logs.slice(0, 50)
  });
});

app.post('/api/admin/content', requireAdmin, (req, res) => {
  const { title, type, description } = req.body;
  if (!title) return res.json({ success: false, message: 'Titre manquant' });
  if (!db) return res.json({ success: false, message: 'Base non disponible' });
  
  const logEntry = {
    name: 'Admin',
    action: `a publié : ${title}`,
    xp: 0,
    time: new Date().toISOString()
  };
  db.ref('activityLogs').push(logEntry);
  res.json({ success: true, message: 'Contenu publié !' });
});

app.post('/api/admin/generate-quiz', requireAdmin, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.json({ success: false, message: 'Clé API non configurée' });
  }
  const { theme, difficulty } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Génère une question de quiz biblique sur "${theme}" pour des enfants (${difficulty}). Format exact:\nQUESTION: [la question]\nA: [option A]\nB: [option B]\nC: [option C]\nD: [option D]\nREPONSE: [lettre]\nEXPLICATION: [1-2 phrases]\nEn français.`
        }]
      })
    });
    const data = await response.json();
    res.json({ success: true, text: data.content?.[0]?.text || '' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════
// DÉMARRAGE
// ══════════════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ Ecodime Server démarré sur le port ${PORT}`);
  console.log(`🌍 Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 API Key: ${ANTHROPIC_API_KEY ? '✅ Configurée' : '❌ Manquante'}`);
  console.log(`🔥 Firebase Admin: ${db ? '✅ Actif' : '❌ Non configuré'}`);
});
