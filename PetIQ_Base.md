# Pet IQ Lab — Base du projet

## Concept
Quiz d'intelligence animale (chien/chat) basé sur des études scientifiques réelles.
20 questions comportementales → score /60 → profil cognitif → paywall → rapport PDF payant.

Différenciateur : ancré dans de vraie science (Coren, Hare, Bray, Miklósi, Kaminski),
présenté de façon fun. Pas de l'astrologie — de l'éthologie appliquée.

---

## Modèle économique
- Quiz gratuit (acquisition / viralité)
- Paywall à la fin : rapport PDF complet à €4.99
- Email capture fallback (lead gen → relance Resend)
- Upsell vers The Cosmic Pet (thecosmicpet.com)
- Image de résultat partageable → viralité Instagram/TikTok

---

## Stack cible (même que The Cosmic Pet)
- Frontend : HTML/CSS/JS statique → Vercel
- Backend : Node.js/Express → Cloud Run europe-west9
- IA : Gemini 2.5 Flash (génération rapport PDF)
- PDF : Puppeteer → template HTML
- Email : Resend
- Paiement : Paddle (Merchant of Record)
- Storage : Firestore
- Analytics : GA4 + Meta Pixel + TikTok Pixel

---

## Structure du quiz

5 dimensions cognitives × 4 questions = 20 questions, score /60

1. Memory & Learning      — Coren 1994 · Tulving
2. Social Intelligence    — Hare & Tomasello 2005 · Kaminski
3. Problem Solving        — Miklósi 2003 · Osthaus 2005
4. Self-Control           — Bray, MacLean & Hare 2014
5. Adaptability           — Coren adaptive intelligence

### Scoring
- Chaque option : 0, 1, 2 ou 3 points
- Options shufflées aléatoirement à chaque session (score 3 jamais en premier)
- Ordre stable par question (back/forward cohérent)
- Score chat × 1.12 (normalisation biais tests chien)

---

## Profils chiens
- 0-24  : 🌀 The Free Spirit
- 25-34 : 🎭 The Independent Thinker
- 35-44 : ⚖️  The Balanced Mind
- 45-54 : ⚡ The Quick Learner
- 55-60 : 🏆 The Canine Genius

## Profils chats
- 0-24  : 🌙 The Philosopher
- 25-34 : 🎭 The Selective Genius
- 35-44 : ⚖️  The Composed Observer
- 45-54 : ⚡ The Sharp Operator
- 55-60 : 🏆 The Cat Einstein

---

## Optimisations cash (toutes implémentées dans pet-iq-v4-final.html)
1. Ticker social proof en intro
2. Téaser mi-parcours à Q10
3. Insights personnalisés pendant l'analyse
4. Percentile comme hero metric (pas score brut)
5. Bouton Back très discret
6. Live test en badge compact (non bloquant)
7. Countdown 24h sur le paywall (sessionStorage)
8. CTA émotionnel : "Discover what makes Rex exceptional"
9. Email capture fallback → POST /api/email-capture
10. Image partageable 1080×1080 Canvas

---

## À faire (Phase 1 MVP)
- [ ] server.js : checkout Paddle, webhook, génération Gemini, PDF Puppeteer, email Resend
- [ ] Firestore : stocker sessions + email captures
- [ ] Template PDF (pdf_template.html) pour le rapport
- [ ] Brancher /api/email-capture
- [ ] GA4 + pixels Meta/TikTok
- [ ] Version FR

---

## Références scientifiques
- Hare et al. 2002, Science — pointing comprehension
- Kaminski et al. 2004, Science — word learning (Rico)
- Miklósi et al. 2003, Animal Cognition — detour task
- Bray et al. 2014, Animal Behaviour — delay of gratification
- Custance & Mayer 2012, Animal Cognition — empathic response
- Takagi et al. 2017 — episodic memory cats

---

## Infos société
- REAUMUR SAS, SIREN 838 137 305
- 9 rue des Colonnes, 75002 Paris
- contact@thecosmicpet.com
- Repo référence : jeremieleitao/the-cosmic-pet-frontend
- Backend référence : Cloud Run cosmicpet-api, europe-west9
- Domaine suggéré : petiqlab.com
