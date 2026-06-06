const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════
// CONFIGURATION SÉCURISÉE (variables d'environnement)
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

// Session sécurisée
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 heures
  }
}));

// Protection CSRF basique
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ══════════════════════════════════════
// BASE DE DONNÉES EN MÉMOIRE (remplacer par une vraie DB plus tard)
// ══════════════════════════════════════
let users = [];
let activityLogs = [];
let stats = { quizDone: 0, storiesPlayed: 0 };

// ══════════════════════════════════════
// ROUTES PUBLIQUES
// ══════════════════════════════════════

// Page principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── INSCRIPTION ──
app.post('/api/register', (req, res) => {
  const { prenom, nom, pays, ville, eglise } = req.body;
  
  if (!prenom) {
    return res.json({ success: false, message: 'Le prénom est obligatoire' });
  }

  // Vérifier si déjà inscrit
  const existing = users.find(u => 
    u.prenom.toLowerCase() === prenom.toLowerCase() && 
    u.nom.toLowerCase() === (nom || '').toLowerCase()
  );
  
  if (existing) {
    return res.json({ success: false, message: 'Ce nom existe déjà !' });
  }

  const newUser = {
    id: Date.now().toString(),
    prenom,
    nom: nom || '',
    pays: pays || '',
    ville: ville || '',
    eglise: eglise || '',
    xp: 0,
    coins: 0,
    storiesDone: [],
    quizDone: 0,
    registeredAt: new Date().toISOString(),
    lastActive: new Date().toISOString()
  };

  users.push(newUser);
  
  // Créer session
  req.session.userId = newUser.id;
  req.session.prenom = newUser.prenom;
  
  // Log activité
  activityLogs.unshift({
    name: prenom + ' ' + nom,
    action: 's\'est inscrit(e)',
    xp: 0,
    time: new Date().toISOString()
  });

  res.json({ success: true, user: newUser });
});

// ── CONNEXION ──
app.post('/api/login', (req, res) => {
  const { prenom } = req.body;
  
  if (!prenom) {
    return res.json({ success: false, message: 'Entre ton prénom' });
  }

  const user = users.find(u => u.prenom.toLowerCase() === prenom.toLowerCase());
  
  if (!user) {
    return res.json({ success: false, message: 'Prénom introuvable ! Inscris-toi d\'abord.' });
  }

  user.lastActive = new Date().toISOString();
  req.session.userId = user.id;
  req.session.prenom = user.prenom;

  res.json({ success: true, user });
});

// ── DÉCONNEXION ──
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── VÉRIFIER SESSION ──
app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user });
});

// ── SAUVEGARDER PROGRESSION ──
app.post('/api/progress', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: 'Non connecté' });
  }

  const { xp, coins, storiesDone, storyCompleted } = req.body;
  const user = users.find(u => u.id === req.session.userId);
  
  if (!user) return res.status(404).json({ success: false });

  user.xp = xp || user.xp;
  user.coins = coins || user.coins;
  user.storiesDone = storiesDone || user.storiesDone;
  user.lastActive = new Date().toISOString();

  if (storyCompleted) {
    stats.storiesPlayed++;
    activityLogs.unshift({
      name: user.prenom + ' ' + user.nom,
      action: 'a terminé l\'histoire : ' + storyCompleted,
      xp: 200,
      time: new Date().toISOString()
    });
    if (activityLogs.length > 100) activityLogs.pop();
  }

  res.json({ success: true });
});

// ── LOG QUIZ ──
app.post('/api/quiz-done', (req, res) => {
  if (!req.session.userId) return res.json({ success: false });
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ success: false });
  
  const { score } = req.body;
  stats.quizDone++;
  user.quizDone = (user.quizDone || 0) + 1;
  
  activityLogs.unshift({
    name: user.prenom + ' ' + user.nom,
    action: `a complété un Quiz ${score}/5`,
    xp: score * 30,
    time: new Date().toISOString()
  });
  if (activityLogs.length > 100) activityLogs.pop();
  
  res.json({ success: true });
});

// ══════════════════════════════════════
// ROUTE IA SÉCURISÉE (clé API côté serveur)
// ══════════════════════════════════════
app.post('/api/chat', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Non connecté' });
  }

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
    
    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    res.json({ text: data.content?.[0]?.text || '' });

  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════
// ROUTES ADMIN SÉCURISÉES (côté serveur)
// ══════════════════════════════════════

// Middleware admin
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

// ── LOGIN ADMIN ──
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password !== ADMIN_PASSWORD) {
    // Délai pour ralentir les attaques brute force
    setTimeout(() => {
      res.json({ success: false, message: 'Mot de passe incorrect' });
    }, 1000);
    return;
  }

  req.session.isAdmin = true;
  res.json({ success: true });
});

// ── LOGOUT ADMIN ──
app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

// ── DONNÉES ADMIN ──
app.get('/api/admin/data', requireAdmin, (req, res) => {
  const countries = new Set(users.map(u => u.pays).filter(p => p)).size;
  
  res.json({
    stats: {
      totalUsers: users.length,
      storiesPlayed: stats.storiesPlayed,
      quizDone: stats.quizDone,
      countries
    },
    users: users.map(u => ({
      id: u.id,
      prenom: u.prenom,
      nom: u.nom,
      pays: u.pays,
      ville: u.ville,
      eglise: u.eglise,
      xp: u.xp,
      coins: u.coins,
      storiesDone: u.storiesDone,
      quizDone: u.quizDone,
      registeredAt: u.registeredAt,
      lastActive: u.lastActive
    })),
    logs: activityLogs.slice(0, 50)
  });
});

// ── VÉRIFIER ADMIN SESSION ──
app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// ── PUBLIER CONTENU (admin) ──
app.post('/api/admin/content', requireAdmin, (req, res) => {
  const { title, type, description } = req.body;
  if (!title) return res.json({ success: false, message: 'Titre manquant' });
  
  activityLogs.unshift({
    name: 'Admin',
    action: `a publié : ${title}`,
    xp: 0,
    time: new Date().toISOString()
  });
  
  res.json({ success: true, message: 'Contenu publié !' });
});

// ── GÉNÉRER QUIZ (admin) ──
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
// DÉMARRAGE SERVEUR
// ══════════════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ Ecodime Server démarré sur le port ${PORT}`);
  console.log(`🌍 Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 API Key: ${ANTHROPIC_API_KEY ? '✅ Configurée' : '❌ Manquante'}`);
});
