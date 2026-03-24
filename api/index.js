// Pet IQ Lab — Backend API
// Cloud Run · europe-west9 · project: cosmicpet
// Pattern: Gemini → Firestore → lien email (même que Cosmic Pet, sans Puppeteer)
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const crypto    = require('crypto');
const path      = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Resend }             = require('resend');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const app = express();

const ALLOWED_ORIGINS = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : ['https://iq.thecosmicpet.com'];

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST'],
}));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({
  verify: (req, _res, buf) => {
    if (req.path === '/api/webhook') req.rawBody = buf;
  },
}));

// ── Config ──
const PADDLE_API_KEY        = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const PADDLE_PRICE_ID       = process.env.PADDLE_PRICE_ID;
const PADDLE_ENV            = process.env.PADDLE_ENVIRONMENT || 'production';
const PADDLE_BASE           = PADDLE_ENV === 'sandbox'
  ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
const PORT                  = process.env.PORT || 8080;
const PROJECT_ID            = process.env.GOOGLE_CLOUD_PROJECT || 'cosmicpet';
const BASE_URL              = process.env.BASE_URL || 'https://iq.thecosmicpet.com';
const RESEND_FROM           = process.env.RESEND_FROM || 'Pet IQ Lab <results@thecosmicpet.com>';

const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// Firestore: sur Vercel, les credentials sont dans l'env var JSON
let db;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  db = new Firestore({ projectId: PROJECT_ID, credentials });
} else {
  db = new Firestore({ projectId: PROJECT_ID }); // ADC (Cloud Run / local gcloud)
}

// ── Email validation ──
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length < 200;
}

// ── Rate limiter ──
const _rateMap      = new Map();
const _rateMapEmail = new Map();

function rateLimit(ip, max = 10, windowMs = 60000) {
  const now = Date.now();
  const rec = _rateMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
  rec.count++;
  _rateMap.set(ip, rec);
  return rec.count > max;
}

function rateLimitEmail(email, max = 3, windowMs = 3600000) {
  const key = email.toLowerCase();
  const now = Date.now();
  const rec = _rateMapEmail.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
  rec.count++;
  _rateMapEmail.set(key, rec);
  return rec.count > max;
}

// ── Gemini output sanitization (prevent stored XSS) ──
function sanitizeGeminiOutput(text) {
  return text.replace(/<[^>]+>/g, '').replace(/javascript:/gi, '');
}

// ── Paddle webhook signature ──
function verifyWebhook(req) {
  if (!PADDLE_WEBHOOK_SECRET) return true;
  const header = req.headers['paddle-signature'];
  if (!header || !req.rawBody) return false;
  const parts = Object.fromEntries(header.split(';').map(p => p.split('=')));
  const { ts, h1 } = parts;
  if (!ts || !h1) return false;
  const digest = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(`${ts}:${req.rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h1, 'hex'), Buffer.from(digest, 'hex'));
  } catch { return false; }
}

// ── Retry Firestore ──
async function getPendingOrder(sessionToken, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const snap = await db.collection('petiq_pending').doc(sessionToken).get();
    if (snap.exists) return snap;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

// ── Dimension metadata ──
const DIMS = [
  { key: 'memory',       label: 'Memory & Learning',   icon: '🧠', color: '#818cf8', max: 6,  source: 'Coren 1994 · Tulving' },
  { key: 'social',       label: 'Social Intelligence',  icon: '👁️', color: '#f472b6', max: 9,  source: 'Hare & Tomasello 2005' },
  { key: 'problem',      label: 'Problem Solving',      icon: '🔧', color: '#fb923c', max: 9,  source: 'Miklósi 2003 · Osthaus' },
  { key: 'selfcontrol',  label: 'Self-Control',         icon: '🧘', color: '#4ade80', max: 6,  source: 'Bray, MacLean & Hare 2014' },
  { key: 'adaptability', label: 'Adaptability',         icon: '🌍', color: '#facc15', max: 6,  source: 'Coren adaptive intelligence' },
];

// ─────────────────────────────────────────────────────────
// GEMINI — GENERATE REPORT CONTENT
// ─────────────────────────────────────────────────────────
async function generateReportContent(orderData) {
  const { petName, petType, breed, profileName, profileEmoji, normScore, percentile, iqScore, dimScores } = orderData;
  const species = petType === 'cat' ? 'cat' : 'dog';
  const breedLine = breed ? `- Breed: ${breed}` : '';

  const dimLines = DIMS.map(d => {
    const raw = dimScores[d.key] || 0;
    const pct = Math.round((raw / d.max) * 100);
    return `- ${d.icon} ${d.label}: ${raw}/${d.max} (${pct}%) — source: ${d.source}`;
  }).join('\n');

  const weakest  = DIMS.reduce((a, b) => ((dimScores[a.key]||0)/a.max < (dimScores[b.key]||0)/b.max) ? a : b);
  const strongest = DIMS.reduce((a, b) => ((dimScores[a.key]||0)/a.max > (dimScores[b.key]||0)/b.max) ? a : b);

  const breedPercentileNote = breed
    ? `top ${100 - percentile}% of ${breed}s specifically (breed-adjusted score)`
    : `top ${100 - percentile}% of ${species}s tested`;

  const prompt = `You are an expert in animal cognition writing a premium, personalised intelligence report. You write like a scientist who genuinely cares about this specific animal — warm, precise, slightly witty. Never generic. Every sentence should feel like it could ONLY be written about ${petName}.

PET PROFILE:
- Name: ${petName} (${species})
${breedLine}
- Cognitive profile: ${profileEmoji} ${profileName}
- Pet IQ Score: ${iqScore} (mean=100, SD=15 — same scale as human IQ, calibrated for ${species}s)
- Percentile: ${breedPercentileNote}
- Strongest dimension: ${strongest.label}
- Weakest dimension: ${weakest.label}

DIMENSION SCORES:
${dimLines}

Write the complete report with EXACTLY this structure:

## ${DIMS[0].icon} Memory & Learning — ${dimScores.memory||0}/${DIMS[0].max}
### INSIGHT
[One punchy sentence, max 12 words, effect "that's exactly it"]
[2-3 short paragraphs: what this score means for ${petName} specifically, one real-world behaviour it explains, one scientific reference with author/year]
### WHAT TO DO
[One concrete, fun exercise to boost this dimension — 2 sentences]

## ${DIMS[1].icon} Social Intelligence — ${dimScores.social||0}/${DIMS[1].max}
### INSIGHT
[One punchy sentence, max 12 words]
[2-3 short paragraphs — Hare & Tomasello pointing test, Kaminski word learning, emotional attunement]
### WHAT TO DO
[One concrete exercise — 2 sentences]

## ${DIMS[2].icon} Problem Solving — ${dimScores.problem||0}/${DIMS[2].max}
### INSIGHT
[One punchy sentence, max 12 words]
[2-3 short paragraphs — Miklósi detour task, persistence vs giving up, what it says about ${petName}]
### WHAT TO DO
[One concrete exercise — 2 sentences]

## ${DIMS[3].icon} Self-Control — ${dimScores.selfcontrol||0}/${DIMS[3].max}
### INSIGHT
[One punchy sentence, max 12 words]
[2-3 short paragraphs — Bray et al. delay of gratification, link to learning speed, impulse regulation]
### WHAT TO DO
[One concrete exercise — 2 sentences]

## ${DIMS[4].icon} Adaptability — ${dimScores.adaptability||0}/${DIMS[4].max}
### INSIGHT
[One punchy sentence, max 12 words]
[2-3 short paragraphs — Coren adaptive intelligence, novelty response, environment flexibility]
### WHAT TO DO
[One concrete exercise — 2 sentences]

## 🏆 ${petName}'s Cognitive Signature
[One paragraph, 4-5 sentences: ${petName}'s unique combination of strengths, what makes them cognitively distinctive, what this means day-to-day. End with something true and slightly unexpected.]

RULES:
- Start directly. No preamble. No "Based on your responses..." opener.
- Use **bold** for key insights. Keep paragraphs short (2-3 sentences max).
- Be radically specific to ${petName}'s actual scores — if you write something that could apply to any ${species}, rewrite it.
- Each INSIGHT sentence must be so accurate it makes the owner think "how did it know that?"
- ${breed ? `Reference ${breed}-specific cognitive traits where scientifically relevant (e.g. ${breed}s are known for X).` : ''}
- The final "Cognitive Signature" section must end with one sentence that is genuinely surprising or counterintuitive.
- 600-800 words total.`;

  const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  const raw     = result.response.text();
  const content = sanitizeGeminiOutput(raw);
  console.log(`✅ Report generated (${content.length} chars)`);
  if (!content || content.length < 200) throw new Error(`Gemini content too short (${content.length} chars)`);
  return content;
}

// ─────────────────────────────────────────────────────────
// EMAIL — send link (no attachment)
// ─────────────────────────────────────────────────────────
async function sendReportEmail(email, orderData, reportUrl) {
  const { petName, profileEmoji, profileName, percentile, iqScore, petType, normScore } = orderData;
  const speciesLabel = petType === 'cat' ? 'cats' : 'dogs';

  const dimRows = DIMS.map(d => {
    const raw = orderData.dimScores[d.key] || 0;
    const pct = Math.round((raw / d.max) * 100);
    return `<tr><td style="padding:6px 0;border-bottom:1px solid rgba(11,31,58,.06);">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="24" style="font-size:16px">${d.icon}</td>
        <td style="padding-left:8px;font-size:12px;font-weight:700;color:#374151">${d.label}</td>
        <td width="40" align="right" style="font-size:12px;font-weight:800;color:${d.color}">${pct}%</td>
      </tr></table>
    </td></tr>`;
  }).join('');

  await resend.emails.send({
    from: RESEND_FROM,
    to: email,
    subject: `${petName} scored IQ ${iqScore} 🧠 — here's the full breakdown`,
    html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f2ede6;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:540px;margin:0 auto;padding:32px 16px;">

  <!-- Header -->
  <div style="text-align:center;margin-bottom:24px;">
    <div style="font-size:11px;font-weight:800;color:#e8185e;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px">🧠 Pet IQ Lab</div>
    <h1 style="font-size:28px;font-weight:800;color:#0b1f3a;margin:0 0 6px;font-style:italic">${petName}'s report is ready</h1>
    <p style="color:#8a8278;font-size:14px;margin:0;font-weight:600">Your full cognitive analysis is one tap away.</p>
  </div>

  <!-- Score card -->
  <div style="background:linear-gradient(135deg,#0b1f3a,#0d2a4a);border-radius:20px;padding:28px;text-align:center;margin-bottom:20px;">
    <div style="font-size:44px;margin-bottom:8px">${profileEmoji}</div>
    <div style="font-size:20px;font-weight:800;color:white;font-style:italic;margin-bottom:6px">${profileName}</div>
    <div style="font-size:13px;color:rgba(255,255,255,.4);font-weight:700;margin-bottom:20px">Pet IQ: ${iqScore} · top ${100 - percentile}% of ${speciesLabel}</div>
    <a href="${reportUrl}" style="display:inline-block;background:linear-gradient(135deg,#e8185e,#1d6ef5);color:white;text-decoration:none;padding:16px 32px;border-radius:14px;font-size:16px;font-weight:900;box-shadow:0 8px 24px rgba(232,24,94,.35)">
      🔓 Open ${petName}'s full report →
    </a>
    <div style="margin-top:10px;font-size:11px;color:rgba(255,255,255,.25)">Link valid for 30 days</div>
  </div>

  <!-- Dim preview -->
  <div style="background:white;border-radius:16px;padding:20px;margin-bottom:20px;border:1.5px solid rgba(11,31,58,.06);">
    <div style="font-size:11px;font-weight:800;color:#e8185e;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Dimension breakdown</div>
    <table width="100%" cellpadding="0" cellspacing="0" border="0">${dimRows}</table>
  </div>

  <!-- CTA repeat -->
  <div style="text-align:center;margin-bottom:24px;">
    <a href="${reportUrl}" style="display:inline-block;background:#0b1f3a;color:white;text-decoration:none;padding:14px 28px;border-radius:12px;font-size:14px;font-weight:800">
      Read ${petName}'s full report →
    </a>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding-top:16px;border-top:1px solid rgba(11,31,58,.08);">
    <p style="font-size:11px;color:#9ca3af;margin:0;line-height:1.8">
      Pet IQ Lab · thecosmicpet.com<br>
      REAUMUR SAS · 9 rue des Colonnes, 75002 Paris<br>
      <a href="mailto:contact@thecosmicpet.com" style="color:#e8185e;text-decoration:none">contact@thecosmicpet.com</a>
    </p>
  </div>

</div>
</body></html>`,
  });
}

// ─────────────────────────────────────────────────────────
// MAIN FLOW — génère rapport + stocke + envoie email
// ─────────────────────────────────────────────────────────
async function generateAndSend(email, orderData) {
  const content  = await generateReportContent(orderData);
  const token    = crypto.randomUUID();
  const reportUrl = `${BASE_URL}/report.html?token=${token}`;

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.collection('petiq_reports').doc(token).set({
    ...orderData,
    email,
    content,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
  });
  console.log(`💾 Report saved — token: ${token}`);

  // Increment total tests counter (fire-and-forget)
  db.collection('petiq_meta').doc('counters').set(
    { total_tests: FieldValue.increment(1) },
    { merge: true }
  ).catch(()=>{});

  await sendReportEmail(email, orderData, reportUrl);
  console.log(`📬 Email sent — report delivered`);

  // ── J+3: Nurture email ──
  const j3 = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const { petName, petType, profileEmoji, profileName, iqScore } = orderData;
  const strongest = DIMS.reduce((a,b) => ((orderData.dimScores[a.key]||0)/a.max > (orderData.dimScores[b.key]||0)/b.max) ? a : b);
  const weakest   = DIMS.reduce((a,b) => ((orderData.dimScores[a.key]||0)/a.max < (orderData.dimScores[b.key]||0)/b.max) ? a : b);
  resend.emails.send({
    from: RESEND_FROM, to: email,
    scheduledAt: j3,
    subject: `One thing ${petName}'s score reveals 🧠`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f2ede6;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:32px 16px;">
  <div style="font-size:11px;font-weight:800;color:#e8185e;letter-spacing:3px;text-transform:uppercase;margin-bottom:20px">🧠 Pet IQ Lab</div>
  <h1 style="font-size:24px;font-weight:800;color:#0b1f3a;margin:0 0 16px;font-style:italic">${petName}'s strongest dimension: ${strongest.icon} ${strongest.label}</h1>
  <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px">According to <strong>${petName}'s IQ report (${iqScore})</strong>, their peak cognitive strength is <strong>${strongest.label}</strong> — the dimension that ${strongest.key === 'social' ? 'governs how they read your emotions and intentions' : strongest.key === 'memory' ? 'determines how quickly they encode and recall information' : strongest.key === 'problem' ? 'drives how they approach and solve novel challenges' : strongest.key === 'selfcontrol' ? 'controls how they regulate impulses under temptation' : 'shapes how flexibly they adapt to new environments'}.</p>
  <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 24px">This is also the dimension most closely linked to learning speed in the research of ${strongest.source}.</p>
  <div style="background:#0b1f3a;border-radius:16px;padding:20px;text-align:center;margin-bottom:20px">
    <p style="color:rgba(255,255,255,.6);font-size:13px;margin:0 0 12px">${petName}'s full report — still available</p>
    <a href="${reportUrl}" style="display:inline-block;background:linear-gradient(135deg,#e8185e,#1d6ef5);color:white;text-decoration:none;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:800">Read ${petName}'s report →</a>
  </div>
  <p style="font-size:11px;color:#9ca3af;text-align:center;margin:0">Pet IQ Lab · <a href="https://thecosmicpet.com" style="color:#9ca3af">thecosmicpet.com</a></p>
</div></body></html>`,
  }).catch(e => console.error('J+3 email error:', e));

  // ── J+7: Upsell training ──
  const j7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  resend.emails.send({
    from: RESEND_FROM, to: email,
    scheduledAt: j7,
    subject: `A 21-day training plan for ${petName}'s weak spot 🎯`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f2ede6;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:32px 16px;">
  <div style="font-size:11px;font-weight:800;color:#1d6ef5;letter-spacing:3px;text-transform:uppercase;margin-bottom:20px">🎯 Training Plan</div>
  <h1 style="font-size:24px;font-weight:800;color:#0b1f3a;margin:0 0 16px;font-style:italic">Boost ${petName}'s ${weakest.label}</h1>
  <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 16px">${petName}'s IQ report showed that <strong>${weakest.label}</strong> is their development area. The good news: ${weakest.key === 'selfcontrol' ? "self-control is the most trainable cognitive dimension according to Bray et al. (2014)" : weakest.key === 'memory' ? "memory can be significantly improved with the right daily exercises (Tulving 2002)" : weakest.key === 'social' ? "social intelligence responds quickly to structured training (Kaminski 2004)" : weakest.key === 'problem' ? "problem-solving skills improve rapidly with graduated challenge exercises (Miklósi 2003)" : "adaptability can be built systematically through controlled novelty exposure"}.</p>
  <p style="color:#374151;font-size:15px;line-height:1.7;margin:0 0 24px">We're building a <strong>21-day personalised training programme</strong> for ${petName} — 5 minutes per day, grounded in the same research as the report. Interested?</p>
  <div style="background:#0b1f3a;border-radius:16px;padding:20px;text-align:center">
    <p style="color:rgba(255,255,255,.6);font-size:13px;margin:0 0 12px">Early access — €9.99 one-time</p>
    <a href="${BASE_URL}/?upsell=training&pet=${encodeURIComponent(petName)}" style="display:inline-block;background:linear-gradient(135deg,#1d6ef5,#818cf8);color:white;text-decoration:none;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:800">Get ${petName}'s training plan →</a>
  </div>
  <p style="font-size:11px;color:#9ca3af;text-align:center;margin-top:20px">Pet IQ Lab · <a href="https://thecosmicpet.com" style="color:#9ca3af">thecosmicpet.com</a></p>
</div></body></html>`,
  }).catch(e => console.error('J+7 email error:', e));

  return token;
}

// ─────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, service: 'petiq-api' }));

app.get('/api/stats', async (_req, res) => {
  try {
    const snap = await db.collection('petiq_meta').doc('counters').get();
    const total = snap.exists ? (snap.data().total_tests || 0) : 0;
    // Seed offset so it starts at a credible number
    res.json({ totalTests: total + 1240 });
  } catch {
    res.json({ totalTests: 1240 });
  }
});

// POST /api/generate — TEST MODE (pas de paiement)
// Génère directement le rapport et envoie l'email
app.post('/api/generate', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  if (rateLimit(ip, 5, 60000)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const { email, petName, petType, normScore, percentile, iqScore, profileName, profileEmoji, dimScores } = req.body;

    if (!isValidEmail(email))  return res.status(400).json({ error: 'Valid email required' });
    if (!petName || !petType)  return res.status(400).json({ error: 'Missing pet data' });
    if (rateLimitEmail(email, 3, 3600000)) return res.status(429).json({ error: 'Too many requests for this email' });

    const orderData = {
      petName:      String(petName).slice(0, 50).replace(/[<>"]/g, ''),
      petType:      petType === 'cat' ? 'cat' : 'dog',
      normScore:    Number(normScore) || 0,
      percentile:   Number(percentile) || 0,
      iqScore:      Number(iqScore) || 0,
      profileName:  String(profileName || '').slice(0, 80),
      profileEmoji: String(profileEmoji || '').slice(0, 10),
      dimScores:    dimScores || {},
    };

    // Génération synchrone (compatible Vercel serverless)
    const token = await generateAndSend(email, orderData);
    console.log(`✅ Test report generated — token: ${token}`);
    res.json({ ok: true, token, message: 'Report generated — check your email!' });

  } catch (err) {
    console.error('POST /api/generate:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/report/:token — frontend fetches this to render the report
app.get('/api/report/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 8) return res.status(400).json({ error: 'Invalid token' });

    const doc = await db.collection('petiq_reports').doc(token).get();
    if (!doc.exists) return res.status(404).json({ error: 'Report not found' });

    const data = doc.data();
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Report link expired' });
    }
    res.json({
      petName:      data.petName,
      petType:      data.petType,
      profileName:  data.profileName,
      profileEmoji: data.profileEmoji,
      normScore:    data.normScore,
      percentile:   data.percentile,
      dimScores:    data.dimScores,
      content:      data.content,
      created_at:   data.created_at,
    });
  } catch (e) {
    console.error('GET /api/report:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/checkout — sauvegarde quiz data, crée transaction Paddle côté serveur, retourne checkoutUrl
app.post('/api/checkout', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  if (rateLimit(ip, 10, 60000)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const { petName, petType, breed, normScore, percentile, iqScore, profileName, profileEmoji, dimScores } = req.body;
    if (!petName || !petType || normScore === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const orderData = {
      petName:      String(petName).slice(0, 50).replace(/[<>"]/g, ''),
      petType:      petType === 'cat' ? 'cat' : 'dog',
      breed:        String(breed || '').slice(0, 80),
      normScore:    Number(normScore),
      percentile:   Number(percentile),
      iqScore:      Number(iqScore) || 0,
      profileName:  String(profileName || '').slice(0, 80),
      profileEmoji: String(profileEmoji || '').slice(0, 10),
      dimScores:    dimScores || {},
      created_at:   new Date(),
    };

    // Trouver la dimension la plus faible pour l'OTO
    const DIM_MAX_MAP = { memory: 6, social: 9, problem: 9, selfcontrol: 6, adaptability: 6 };
    const dimKeys = Object.keys(DIM_MAX_MAP);
    const weakDim = dimKeys.reduce((a, b) =>
      ((orderData.dimScores[a] || 0) / DIM_MAX_MAP[a] < (orderData.dimScores[b] || 0) / DIM_MAX_MAP[b]) ? a : b
    );

    const sessionToken = crypto.randomUUID();
    await db.collection('petiq_pending').doc(sessionToken).set(orderData);
    console.log(`📝 Session saved: ${sessionToken} for ${orderData.petName}`);

    // Créer la transaction Paddle côté serveur (bypass restriction domaine client)
    const paddleRes = await fetch(`${PADDLE_BASE}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ price_id: PADDLE_PRICE_ID, quantity: 1 }],
        custom_data: {
          sessionToken,
          otoPet:     orderData.petName,
          otoSpecies: orderData.petType,
          otoDim:     weakDim,
          otoIq:      String(orderData.iqScore || ''),
        },
      }),
    });

    const paddleJson = await paddleRes.json();
    const txnId = paddleJson.data?.id;
    if (!txnId) {
      console.error('Paddle transaction error:', JSON.stringify(paddleJson));
      return res.status(502).json({ error: 'Could not create Paddle transaction' });
    }

    // URL du checkout hébergé par Paddle (aucun Paddle.js requis côté client)
    const checkoutUrl = `https://checkout.paddle.com/checkout/buy?_ptxn=${txnId}`;
    console.log(`💳 Paddle txn ${txnId} — checkout: ${checkoutUrl}`);

    res.json({ checkoutUrl });
  } catch (err) {
    console.error('POST /api/checkout:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/oto-checkout — crée transaction Paddle pour l'OTO côté serveur
app.post('/api/oto-checkout', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  if (rateLimit(ip, 10, 60000)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const { petName, species, weakDim, iqScore, token } = req.body;

    const paddleRes = await fetch(`${PADDLE_BASE}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ price_id: PADDLE_PRICE_ID, quantity: 1 }],
        custom_data: {
          flow:    'oto',
          petName: String(petName || '').slice(0, 50),
          species: species === 'cat' ? 'cat' : 'dog',
          weakDim: String(weakDim || ''),
          iqScore: String(iqScore || ''),
          token:   String(token || ''),
        },
      }),
    });

    const paddleJson = await paddleRes.json();
    const txnId = paddleJson.data?.id;
    if (!txnId) {
      console.error('Paddle OTO transaction error:', JSON.stringify(paddleJson));
      return res.status(502).json({ error: 'Could not create Paddle transaction' });
    }

    const checkoutUrl = `https://checkout.paddle.com/checkout/buy?_ptxn=${txnId}`;
    res.json({ checkoutUrl });
  } catch (err) {
    console.error('POST /api/oto-checkout:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/payment-done — redirection post-paiement Paddle → OTO avec params
app.get('/api/payment-done', async (req, res) => {
  const txnId = req.query._ptxn;
  if (!txnId) return res.redirect(BASE_URL);

  try {
    const txnRes = await fetch(`${PADDLE_BASE}/transactions/${txnId}`, {
      headers: { 'Authorization': `Bearer ${PADDLE_API_KEY}` },
    });
    const txnJson = await txnRes.json();
    const cd = txnJson.data?.custom_data || {};

    if (cd.flow === 'oto') {
      return res.redirect(
        `${BASE_URL}/oto.html?` + new URLSearchParams({
          pet: cd.petName || '', dim: cd.weakDim || '',
          species: cd.species || 'dog', iq: cd.iqScore || '',
          token: cd.token || '', success: '1',
        }).toString()
      );
    } else {
      return res.redirect(
        `${BASE_URL}/oto.html?` + new URLSearchParams({
          pet: cd.otoPet || '', dim: cd.otoDim || '',
          species: cd.otoSpecies || 'dog', iq: cd.otoIq || '',
          token: cd.sessionToken || '',
        }).toString()
      );
    }
  } catch (err) {
    console.error('GET /api/payment-done:', err);
    return res.redirect(BASE_URL);
  }
});

// POST /api/email-capture — lead sans paiement
app.post('/api/email-capture', async (req, res) => {
  const { email, petName, normScore, percentile } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  try {
    await db.collection('petiq_leads').add({
      email:      String(email).slice(0, 200),
      petName:    String(petName || '').slice(0, 50),
      normScore:  Number(normScore) || 0,
      percentile: Number(percentile) || 0,
      created_at: new Date(),
    });
    console.log(`📧 Lead captured — ${petName}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/email-capture:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────
// 21-DAY PROGRAMME — Gemini content generation
// ─────────────────────────────────────────────────────────
const DIM_LABELS = {
  memory: 'Memory & Learning',
  social: 'Social Intelligence',
  problem: 'Problem Solving',
  selfcontrol: 'Self-Control',
  adaptability: 'Adaptability',
};

async function generateProgrammeContent(petName, species, breed, weakDim, iqScore) {
  const dimLabel = DIM_LABELS[weakDim] || 'Cognitive Training';
  const breedLine = breed && breed !== 'Mixed / Other' ? `Breed: ${breed}. ` : '';

  const prompt = `You are an expert animal cognition trainer creating a personalised 21-day programme.

Pet: ${petName} (${breedLine}${species})
Focus dimension: ${dimLabel} (their weakest cognitive area)
IQ Score: ${iqScore} (scale: mean=100, SD=15)

Generate EXACTLY 21 training days. Return ONLY a valid JSON array — no explanation, no markdown, no other text:
[{"day":1,"title":"...","science":"...","exercise":"...","tip":"..."},...]

Rules:
- title: motivating, max 5 words, specific to today's exercise
- science: one sentence citing a real published study (Author Year) directly relevant to today's exercise
- exercise: specific 5-minute exercise with numbered step-by-step instructions. Use treats/toys only, no equipment. ${species}-appropriate.
- tip: one practical sentence to maximise today's success
- Days 1–7: foundation (easy baseline), Days 8–14: intermediate variations, Days 15–21: advanced + transfer
- All 21 exercises must be distinct — no repetition
- All must specifically train ${dimLabel}
${breed && breed !== 'Mixed / Other' ? `- Reference ${breed}-specific traits or tendencies where scientifically relevant` : ''}
- Day 21 must include a re-test suggestion to measure progress since Day 1`;

  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  const text = result.response.text();

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Programme JSON not found in Gemini response`);
  const days = JSON.parse(match[0]);
  if (!Array.isArray(days) || days.length < 21) throw new Error(`Programme incomplete: ${days.length} days`);
  return days;
}

function programmeDayEmail(petName, dayObj, totalDays = 21) {
  const { day, title, science, exercise, tip } = dayObj;
  const pct = Math.round((day / totalDays) * 100);
  const exerciseHtml = exercise.replace(/\n/g, '<br>');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4ff;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:24px 16px 40px">
  <div style="background:#060b18;border-radius:16px 16px 0 0;padding:22px 24px">
    <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,.35);letter-spacing:2.5px;text-transform:uppercase;margin-bottom:6px">Pet IQ Lab · 21-Day Programme</div>
    <div style="display:flex;align-items:baseline;justify-content:space-between">
      <div style="font-size:22px;font-weight:800;color:white;font-style:italic">${petName}'s Day ${day}</div>
      <div style="font-size:12px;font-weight:700;color:#f43f8f;font-family:monospace">${day} / ${totalDays}</div>
    </div>
  </div>
  <div style="background:#0d1628;height:4px">
    <div style="background:linear-gradient(90deg,#f43f8f,#3b82f6);height:100%;width:${pct}%"></div>
  </div>
  <div style="background:white;padding:24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb">
    <div style="font-size:10px;font-weight:700;color:#3b82f6;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Today's Exercise</div>
    <h2 style="margin:0 0 20px;font-size:20px;font-weight:800;color:#0b1f3a">${title}</h2>
    <div style="background:#eff6ff;border-left:3px solid #3b82f6;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px">
      <div style="font-size:10px;font-weight:700;color:#3b82f6;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">🔬 Science</div>
      <div style="font-size:13px;color:#374151;line-height:1.65">${science}</div>
    </div>
    <div style="font-size:10px;font-weight:700;color:#e8185e;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">⏱️ 5-Minute Exercise</div>
    <div style="font-size:15px;color:#1f2937;line-height:1.85;margin-bottom:20px">${exerciseHtml}</div>
    <div style="background:#fdf0f4;border-radius:10px;padding:14px 16px">
      <span style="font-size:13px;font-weight:700;color:#e8185e">💡 Tip: </span>
      <span style="font-size:13px;color:#374151;line-height:1.6">${tip}</span>
    </div>
  </div>
  <div style="background:#f8fafc;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:14px 24px;text-align:center">
    <div style="font-size:11px;color:#9ca3af">Day ${day} of ${totalDays} · ${petName}'s personalised programme · Pet IQ Lab</div>
  </div>
</div></body></html>`;
}

// POST /api/upsell-generate — generate & schedule 21-day programme
app.post('/api/upsell-generate', async (req, res) => {
  const { email, petName, species, breed, weakDim, iqScore, token } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });

  try {
    const name    = String(petName  || 'Your pet').slice(0, 50);
    const dim     = String(weakDim  || 'memory').slice(0, 50);
    const sp      = String(species  || 'dog').slice(0, 10);
    const br      = String(breed    || '').slice(0, 80);
    const iq      = Number(iqScore) || 100;
    const dimLabel = DIM_LABELS[dim] || 'Cognitive Training';

    // Generate 21 days with Gemini
    console.log(`🎯 Generating programme: ${name} (${br || sp}) — ${dimLabel}`);
    const days = await generateProgrammeContent(name, sp, br, dim, iq);

    // Schedule 21 emails in parallel
    const emailJobs = days.map((dayObj, i) => {
      const payload = {
        from:    RESEND_FROM,
        to:      email,
        subject: `Day ${dayObj.day}: ${dayObj.title} — ${name}'s training 🧠`,
        html:    programmeDayEmail(name, dayObj),
      };
      if (i > 0) {
        payload.scheduledAt = new Date(Date.now() + i * 24 * 60 * 60 * 1000).toISOString();
      }
      return resend.emails.send(payload)
        .catch(e => console.error(`Day ${dayObj.day} send error:`, e));
    });

    await Promise.all(emailJobs);

    // Save record
    await db.collection('petiq_programmes').add({
      email, petName: name, species: sp, breed: br, weakDim: dim, iqScore: iq,
      token: token || '', days_count: days.length, created_at: new Date(),
    });

    console.log(`✅ Programme sent: ${email} — ${name} — 21 days starting now`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/upsell-generate:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/upsell-interest — training programme waitlist
app.post('/api/upsell-interest', async (req, res) => {
  const { email, petName, weakDim } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  try {
    await db.collection('petiq_upsell').add({
      email: String(email).slice(0, 200),
      petName: String(petName || '').slice(0, 50),
      weakDim: String(weakDim || '').slice(0, 50),
      created_at: new Date(),
    });
    console.log(`💰 Upsell interest — ${petName} (${weakDim})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/upsell-interest:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/webhook — Paddle confirme paiement → génère rapport → email
app.post('/api/webhook', async (req, res) => {
  if (!verifyWebhook(req)) {
    console.warn('❌ Invalid webhook signature');
    return res.status(401).send('Invalid signature');
  }
  res.status(200).send('OK'); // Acknowledge immédiatement

  try {
    const eventType = req.body?.event_type;
    const data      = req.body?.data;

    // Remboursement
    if (eventType === 'adjustment.created' && data?.action === 'refund') {
      const txnId = data?.transaction_id;
      if (txnId) {
        const r   = await fetch(`${PADDLE_BASE}/transactions/${txnId}`, {
          headers: { Authorization: `Bearer ${PADDLE_API_KEY}` },
        });
        const txn = await r.json();
        const email = txn?.data?.customer?.email;
        if (email) {
          const snap = await db.collection('petiq_reports')
            .where('email', '==', email).orderBy('created_at', 'desc').limit(1).get();
          if (!snap.empty) await snap.docs[0].ref.update({ refunded: true });
          console.log(`🔄 Refund processed for ${email}`);
        }
      }
      return;
    }

    if (eventType !== 'transaction.completed') return;

    // Idempotency — reject if no orderId
    const orderId = String(data?.id || '');
    if (!orderId) {
      console.error('❌ No orderId in webhook data — rejecting');
      return;
    }
    const already = await db.collection('petiq_processed').doc(orderId).get();
    if (already.exists) {
      console.log(`⚠️ Transaction ${orderId} already processed`);
      return;
    }
    await db.collection('petiq_processed').doc(orderId).set({ processed_at: new Date() });

    // Email depuis Paddle
    let email = data?.customer?.email || data?.billing_details?.email;
    if (!email && data?.customer_id) {
      const r    = await fetch(`${PADDLE_BASE}/customers/${data.customer_id}`, {
        headers: { Authorization: `Bearer ${PADDLE_API_KEY}` },
      });
      const cust = await r.json();
      email = cust?.data?.email;
    }

    // Récupère les données quiz depuis Firestore
    const sessionToken = data?.custom_data?.sessionToken;
    if (!sessionToken) {
      // Transaction OTO (flow: 'oto') ou autre — gérée côté client, rien à faire ici
      console.log(`ℹ️ Webhook transaction ${orderId} — no sessionToken (flow: ${data?.custom_data?.flow || 'unknown'}), skipping`);
      return;
    }

    const snap = await getPendingOrder(sessionToken);
    if (!snap) {
      console.error(`❌ No pending order for token ${sessionToken}`);
      return;
    }

    const orderData = snap.data();
    console.log(`💳 Payment confirmed — ${orderData.petName}`);

    // Génère rapport et envoie email en arrière-plan
    generateAndSend(email, orderData)
      .then(token => {
        console.log(`✅ Done — token: ${token}`);
        // Nettoyer pending
        db.collection('petiq_pending').doc(sessionToken).delete().catch(() => {});
      })
      .catch(err => console.error('❌ generateAndSend failed:', err));

  } catch (err) {
    console.error('❌ Webhook error:', err);
  }
});

// Démarrer le serveur seulement en mode direct (pas Vercel serverless)
if (require.main === module) {
  app.listen(PORT, () => console.log(`🧠 Pet IQ API running on :${PORT}`));
}

module.exports = app;
