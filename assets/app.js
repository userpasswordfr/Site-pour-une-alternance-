'use strict';

/* ---------- Stockage local (protégé : peut être indisponible) ---------- */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('alt:' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('alt:' + key, JSON.stringify(value)); } catch { /* ignoré */ }
  },
};

const STATUTS = [
  { id: 'a_postuler', label: 'À postuler' },
  { id: 'postule', label: 'Postulé' },
  { id: 'relance', label: 'Relancé' },
  { id: 'entretien', label: 'Entretien' },
  { id: 'refus', label: 'Refus' },
  { id: 'accepte', label: 'Acceptée' },
];
const JOURS_AVANT_RELANCE = 7;
// Réglages de départ : filtres à la première visite et mots-clés envoyés aux plateformes.
const PAR_DEFAUT = { filtres: { ville: 'Lyon', rayon: '30' }, motsClesPlateformes: 'développeur web' };

const state = {
  offres: [],
  recruteurs: [],
  majLe: null,
  candidatures: store.get('candidatures', []),
  suivies: store.get('suivies', []),
  alertes: store.get('alertes', []),
  vues: new Set(store.get('vues', [])),
  premiereVisite: store.get('vues', null) === null,
  centre: null,
};

/* ---------- Utilitaires ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '';
}
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function dateFr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}
function joursDepuis(iso) {
  const d = new Date(iso);
  return isNaN(d) ? Infinity : (Date.now() - d.getTime()) / 86400000;
}
function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2600);
}
function save() {
  store.set('candidatures', state.candidatures);
  store.set('suivies', state.suivies);
  store.set('alertes', state.alertes);
  store.set('vues', [...state.vues]);
}

/* ---------- Données ---------- */
async function chargerOffres() {
  try {
    const res = await fetch('data/offres.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.offres = Array.isArray(data.offres) ? data.offres : [];
    state.recruteurs = Array.isArray(data.recruteurs) ? data.recruteurs : [];
    state.majLe = data.mis_a_jour || null;
  } catch {
    state.offres = [];
    state.recruteurs = [];
  }
  $('#maj').textContent = state.majLe
    ? `${state.offres.length} offres · mises à jour le ${new Date(state.majLe).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`
    : 'Aucune offre synchronisée pour le moment';
}

async function geocoder(ville) {
  const v = ville.trim();
  if (!v) return null;
  const cache = store.get('geo', {});
  if (cache[norm(v)]) return cache[norm(v)];
  try {
    const res = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(v)}&fields=centre&boost=population&limit=1`);
    const [commune] = await res.json();
    if (!commune?.centre) return null;
    const [lon, lat] = commune.centre.coordinates;
    cache[norm(v)] = { lat, lon };
    store.set('geo', cache);
    return { lat, lon };
  } catch { return null; }
}

/* ---------- Filtres ---------- */
function lireFiltres() {
  const f = new FormData($('#filtres'));
  return {
    q: f.get('q') || '',
    ville: f.get('ville') || '',
    rayon: f.get('rayon') || '',
    contrat: f.get('contrat') || '',
    niveau: f.get('niveau') || '',
    teletravail: f.get('teletravail') || '',
    source: f.get('source') || '',
    depuis: f.get('depuis') || '',
    tri: f.get('tri') || 'recent',
    suivies: f.get('suivies') === 'on',
    masquerPostulees: f.get('masquerPostulees') === 'on',
  };
}

function ecrireFiltres(filtres) {
  const form = $('#filtres');
  for (const [k, v] of Object.entries(filtres)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
}

function estSuivie(nom) {
  const n = norm(nom);
  return !!n && state.suivies.some((s) => norm(s.nom) === n);
}

function dejaCandidature(offre) {
  return state.candidatures.some((c) => (offre.id && c.offreId === offre.id) || (offre.url && c.url === offre.url));
}

function correspond(offre, f, centre) {
  if (f.q) {
    const texte = norm(`${offre.titre} ${offre.entreprise} ${offre.description} ${offre.ville}`);
    const mots = norm(f.q).split(/\s+/).filter(Boolean);
    if (!mots.every((m) => texte.includes(m))) return false;
  }
  if (f.ville && !(centre && f.rayon)) {
    if (!norm(`${offre.ville} ${offre.adresse}`).includes(norm(f.ville))) return false;
  }
  if (centre && f.rayon) {
    if (offre.lat == null || distanceKm(centre, offre) > Number(f.rayon)) return false;
  }
  if (f.contrat && !(offre.contrat || []).some((c) => norm(c).includes(f.contrat))) return false;
  if (f.niveau && String(offre.niveau_eu || '') !== f.niveau) return false;
  if (f.teletravail && offre.teletravail !== f.teletravail) return false;
  if (f.source && offre.source !== f.source) return false;
  if (f.depuis && joursDepuis(offre.publie_le || offre.vu_le) > Number(f.depuis)) return false;
  if (f.suivies && !estSuivie(offre.entreprise)) return false;
  return true;
}

async function rechercher() {
  const f = lireFiltres();
  store.set('filtres', f);
  state.centre = f.ville ? await geocoder(f.ville) : null;

  let liste = state.offres.filter((o) => correspond(o, f, state.centre));
  if (f.masquerPostulees) liste = liste.filter((o) => !dejaCandidature(o));

  if (f.tri === 'distance' && state.centre) {
    liste.sort((a, b) => (a.lat == null) - (b.lat == null) || distanceKm(state.centre, a) - distanceKm(state.centre, b));
  } else if (f.tri === 'entreprise') {
    liste.sort((a, b) => (a.entreprise || '').localeCompare(b.entreprise || '', 'fr'));
  } else {
    liste.sort((a, b) => new Date(b.publie_le || b.vu_le || 0) - new Date(a.publie_le || a.vu_le || 0));
  }

  $('#nb-resultats').textContent = `${liste.length} offre${liste.length > 1 ? 's' : ''} sur ${state.offres.length}`;
  const cont = $('#liste-offres');
  if (!state.offres.length) {
    cont.innerHTML = `<div class="empty">Aucune offre synchronisée pour l'instant.<br>Configure la synchronisation automatique (voir le README) ou cherche directement sur les plateformes dans l'onglet <a href="#" data-goto="entreprises">Entreprises &amp; plateformes</a>.</div>`;
  } else if (!liste.length) {
    cont.innerHTML = `<div class="empty">Aucune offre ne correspond à ces filtres.</div>`;
  } else {
    cont.innerHTML = liste.slice(0, 300).map(carteOffre).join('');
  }
  majPlateformes();
}

function carteOffre(o) {
  const nouveau = !state.vues.has(o.id);
  const suivie = estSuivie(o.entreprise);
  const dist = state.centre && o.lat != null ? `${Math.round(distanceKm(state.centre, o))} km` : '';
  const tele = { onsite: 'Sur site', hybrid: 'Hybride', remote: 'Télétravail' }[o.teletravail] || '';
  const tags = [
    nouveau ? '<span class="tag new">Nouveau</span>' : '',
    o.source ? `<span class="tag src">${esc(o.source)}</span>` : '',
    ...(o.contrat || []).map((c) => `<span class="tag">${esc(c)}</span>`),
    o.niveau ? `<span class="tag">${esc(o.niveau)}</span>` : '',
    tele ? `<span class="tag">${tele}</span>` : '',
    o.debut ? `<span class="tag">Début ${esc(dateFr(o.debut))}</span>` : '',
    o.publie_le ? `<span class="tag">Publiée le ${esc(dateFr(o.publie_le))}</span>` : '',
  ].join('');
  const url = safeUrl(o.url);
  return `
    <article class="card${suivie ? ' suivie' : ''}">
      <h3>${esc(o.titre)}</h3>
      <div class="muted">${esc(o.entreprise)}${o.ville ? ' · ' + esc(o.ville) : ''}${dist ? ' · ' + dist : ''}</div>
      <div class="meta">${tags}</div>
      ${o.description ? `<p class="desc">${esc(o.description.slice(0, 260))}${o.description.length > 260 ? '…' : ''}</p>` : ''}
      <div class="actions">
        ${url ? `<a class="button small" href="${esc(url)}" target="_blank" rel="noopener">Voir l'offre</a>` : ''}
        <button class="small ghost" data-act="postule" data-id="${esc(o.id)}">J'ai postulé</button>
        <button class="small ghost" data-act="a_postuler" data-id="${esc(o.id)}">À postuler</button>
        ${suivie ? '' : `<button class="small ghost" data-act="suivre" data-nom="${esc(o.entreprise)}">Suivre l'entreprise</button>`}
      </div>
    </article>`;
}

function remplirSources() {
  const sel = $('#sel-source');
  const courant = sel.value;
  const sources = [...new Set(state.offres.map((o) => o.source).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Toutes</option>' + sources.map((s) => `<option>${esc(s)}</option>`).join('');
  sel.value = sources.includes(courant) ? courant : '';
  const villes = [...new Set(state.offres.map((o) => o.ville).filter(Boolean))].sort().slice(0, 200);
  $('#villes-connues').innerHTML = villes.map((v) => `<option value="${esc(v)}">`).join('');
}

/* ---------- Plateformes ---------- */
const PLATEFORMES = [
  { nom: 'LinkedIn', info: 'Offres des dernières 24 h', url: (q, v) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(('alternance ' + q).trim())}&location=${encodeURIComponent(v || 'France')}&f_TPR=r86400` },
  { nom: 'Indeed', info: 'Offres des 3 derniers jours', url: (q, v) => `https://fr.indeed.com/jobs?q=${encodeURIComponent(('alternance ' + q).trim())}&l=${encodeURIComponent(v)}&fromage=3&sort=date` },
  { nom: 'Welcome to the Jungle', info: 'Startups et scale-ups', url: (q, v) => `https://www.welcometothejungle.com/fr/jobs?query=${encodeURIComponent(q)}&refinementList%5Bcontract_type%5D%5B%5D=apprenticeship${v ? '&aroundQuery=' + encodeURIComponent(v) : ''}` },
  { nom: 'HelloWork', info: 'Large choix en régions', url: (q, v) => `https://www.hellowork.com/fr-fr/emploi/recherche.html?k=${encodeURIComponent(q)}&l=${encodeURIComponent(v)}&c=Alternance` },
  { nom: 'France Travail', info: 'Contrats d\'apprentissage', url: (q, v) => `https://candidat.francetravail.fr/offres/recherche?motsCles=${encodeURIComponent(q)}${v ? '&lieux=' + encodeURIComponent(v) : ''}&natureContrat=E2` },
  { nom: 'La bonne alternance', info: 'Service public, offres et entreprises', url: () => 'https://labonnealternance.apprentissage.beta.gouv.fr/recherche' },
  { nom: '1jeune1solution', info: 'Plateforme de l\'État', url: (q) => `https://www.1jeune1solution.gouv.fr/apprentissage${q ? '?libelleMetier=' + encodeURIComponent(q) : ''}` },
  { nom: 'Apec', info: 'Profils Bac+3 et plus', url: (q) => `https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=${encodeURIComponent(('alternance ' + q).trim())}` },
  { nom: 'JobTeaser', info: 'Via ton école', url: () => 'https://www.jobteaser.com/fr/job-offers?contract=alternating' },
  { nom: 'Walt', info: 'Spécialiste de l\'alternance', url: () => 'https://walt.community/' },
  { nom: 'Glassdoor', info: 'Avis et salaires', url: (q, v) => `https://www.glassdoor.fr/Emploi/emplois.htm?sc.keyword=${encodeURIComponent(('alternance ' + q).trim())}${v ? '&locKeyword=' + encodeURIComponent(v) : ''}` },
  { nom: 'Jobijoba', info: 'Agrégateur d\'offres', url: (q, v) => `https://www.jobijoba.com/fr/query/?what=${encodeURIComponent(('alternance ' + q).trim())}&where=${encodeURIComponent(v)}` },
  { nom: 'Meteojob', info: 'Matching par compétences', url: (q, v) => `https://www.meteojob.com/jobs?what=${encodeURIComponent(q)}&where=${encodeURIComponent(v)}&contractTypes=APPRENTICESHIP` },
];

function majPlateformes(depuisRecherche = true) {
  if (depuisRecherche) {
    const f = lireFiltres();
    $('#plat-q').value = f.q || PAR_DEFAUT.motsClesPlateformes;
    $('#plat-ville').value = f.ville;
  }
  const q = $('#plat-q').value.trim();
  const v = $('#plat-ville').value.trim();
  $('#plateformes').innerHTML = PLATEFORMES.map((p) => `
    <a class="platform" href="${esc(p.url(q, v))}" target="_blank" rel="noopener">
      <strong>${esc(p.nom)} ↗</strong><span>${esc(p.info)}</span>
    </a>`).join('');
}

/* ---------- Entreprises ---------- */
function rendreEntreprises() {
  const filtre = norm($('#ent-q').value);
  const parNom = new Map();
  for (const o of state.offres) {
    if (!o.entreprise) continue;
    const cle = norm(o.entreprise);
    const e = parNom.get(cle) || { nom: o.entreprise, offres: 0, villes: new Set(), sources: new Set() };
    e.offres++;
    if (o.ville) e.villes.add(o.ville);
    if (o.source) e.sources.add(o.source);
    parNom.set(cle, e);
  }
  const liste = [...parNom.values()]
    .filter((e) => !filtre || norm(e.nom).includes(filtre))
    .sort((a, b) => b.offres - a.offres || a.nom.localeCompare(b.nom, 'fr'));

  $('#table-entreprises').innerHTML = liste.length ? liste.slice(0, 300).map((e) => `
    <tr>
      <td><strong>${esc(e.nom)}</strong>${estSuivie(e.nom) ? ' <span class="tag src">Suivie</span>' : ''}</td>
      <td>${e.offres}</td>
      <td>${esc([...e.villes].slice(0, 3).join(', '))}${e.villes.size > 3 ? '…' : ''}</td>
      <td>${esc([...e.sources].join(', '))}</td>
      <td class="actions">
        <button class="small ghost" data-act="voir-ent" data-nom="${esc(e.nom)}">Voir les offres</button>
        ${estSuivie(e.nom) ? '' : `<button class="small ghost" data-act="suivre" data-nom="${esc(e.nom)}">Suivre</button>`}
      </td>
    </tr>`).join('') : `<tr><td colspan="5" class="muted">Aucune entreprise pour le moment.</td></tr>`;

  const rec = state.recruteurs.filter((r) => !filtre || norm(r.nom).includes(filtre)).slice(0, 200);
  $('#table-recruteurs').innerHTML = rec.length ? rec.map((r) => `
    <tr>
      <td><strong>${esc(r.nom)}</strong></td>
      <td>${esc(r.secteur || '')}</td>
      <td>${esc(r.ville || r.adresse || '')}</td>
      <td class="actions">
        ${safeUrl(r.url) ? `<a class="button small ghost" href="${esc(r.url)}" target="_blank" rel="noopener">Candidater</a>` : ''}
        <button class="small ghost" data-act="spontanee" data-nom="${esc(r.nom)}" data-url="${esc(safeUrl(r.url))}">Ajouter au suivi</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="4" class="muted">Aucune entreprise synchronisée pour le moment.</td></tr>`;

  $('#liste-suivies').innerHTML = state.suivies.length ? state.suivies.map((s, i) => `
    <li>${safeUrl(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.nom)} ↗</a>` : esc(s.nom)}
      <button title="Ne plus suivre" data-act="unfollow" data-i="${i}">✕</button></li>`).join('')
    : '<li class="muted" style="background:none">Aucune entreprise suivie.</li>';
}

function suivre(nom, url = '') {
  if (!nom || estSuivie(nom)) return;
  state.suivies.push({ nom, url });
  save();
  toast(`Tu suis maintenant ${nom}`);
  toutRendre();
}

/* ---------- Candidatures ---------- */
function ajouterCandidature(c) {
  state.candidatures.unshift({ id: uid(), date: today(), statut: 'postule', notes: '', ...c });
  save();
  toutRendre();
}

function candidatureDepuisOffre(id, statut) {
  const o = state.offres.find((x) => x.id === id);
  if (!o) return;
  if (dejaCandidature(o)) { toast('Cette offre est déjà dans tes candidatures'); return; }
  ajouterCandidature({
    offreId: o.id, titre: o.titre, entreprise: o.entreprise, source: o.source || 'La bonne alternance',
    url: o.url || '', statut, date: today(),
  });
  toast(statut === 'postule' ? 'Candidature enregistrée' : 'Ajoutée à ta liste « À postuler »');
}

function aRelancer(c) {
  return c.statut === 'postule' && joursDepuis(c.date) >= JOURS_AVANT_RELANCE;
}

function rendreCandidatures() {
  const optionsStatut = STATUTS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  $$('.sel-statut').forEach((s) => { if (!s.options.length) { s.innerHTML = optionsStatut; s.value = 'postule'; } });
  const filtreSel = $('#cand-filtre');
  if (filtreSel.options.length === 1) filtreSel.insertAdjacentHTML('beforeend', optionsStatut + '<option value="relancer">À relancer</option>');

  const parStatut = Object.fromEntries(STATUTS.map((s) => [s.id, 0]));
  state.candidatures.forEach((c) => { parStatut[c.statut] = (parStatut[c.statut] || 0) + 1; });
  const nbRelance = state.candidatures.filter(aRelancer).length;
  $('#stats').innerHTML = [
    `<div class="stat"><b>${state.candidatures.length}</b><span>Au total</span></div>`,
    ...STATUTS.map((s) => `<div class="stat"><b>${parStatut[s.id]}</b><span>${s.label}</span></div>`),
    `<div class="stat"><b>${nbRelance}</b><span>À relancer (+${JOURS_AVANT_RELANCE} j)</span></div>`,
  ].join('');

  const badge = $('#badge-cand');
  badge.hidden = !state.candidatures.length;
  badge.textContent = state.candidatures.length;

  const filtre = filtreSel.value;
  const liste = state.candidatures.filter((c) => !filtre || (filtre === 'relancer' ? aRelancer(c) : c.statut === filtre));
  $('#table-cand').innerHTML = liste.length ? liste.map((c) => `
    <tr class="${aRelancer(c) ? 'relance' : ''}" data-id="${esc(c.id)}">
      <td>${safeUrl(c.url) ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.titre)}</a>` : esc(c.titre)}
        ${aRelancer(c) ? '<div class="small" style="color:var(--warn)">Pense à relancer</div>' : ''}</td>
      <td>${esc(c.entreprise)}</td>
      <td>${esc(c.source)}</td>
      <td><input type="date" value="${esc(c.date)}" data-field="date"></td>
      <td><select data-field="statut">${STATUTS.map((s) => `<option value="${s.id}"${s.id === c.statut ? ' selected' : ''}>${s.label}</option>`).join('')}</select></td>
      <td><textarea rows="1" data-field="notes">${esc(c.notes)}</textarea></td>
      <td class="actions"><button class="small danger" data-act="del-cand">Supprimer</button></td>
    </tr>`).join('') : `<tr><td colspan="7" class="muted">Aucune candidature${filtre ? ' avec ce statut' : ''}.</td></tr>`;
}

/* ---------- Alertes et notifications ---------- */
function decrireAlerte(f) {
  const parts = [];
  if (f.q) parts.push(`« ${f.q} »`);
  if (f.ville) parts.push(f.ville + (f.rayon ? ` (${f.rayon} km)` : ''));
  if (f.contrat) parts.push(f.contrat);
  if (f.niveau) parts.push({ 3: 'CAP/BEP', 4: 'Bac', 5: 'Bac+2', 6: 'Bac+3', 7: 'Bac+5' }[f.niveau]);
  if (f.teletravail) parts.push({ onsite: 'sur site', hybrid: 'hybride', remote: 'télétravail' }[f.teletravail]);
  if (f.source) parts.push(f.source);
  if (f.suivies) parts.push('entreprises suivies');
  return parts.join(' · ') || 'Toutes les offres';
}

function nouvellesOffres() {
  return state.offres.filter((o) => !state.vues.has(o.id) && interesse(o));
}

function interesse(o) {
  if (estSuivie(o.entreprise)) return true;
  if (!state.alertes.length) return true;
  return state.alertes.some((a) => correspond(o, { ...a.filtres, depuis: '' }, a.centre));
}

function rendreAlertes() {
  $('#liste-alertes').innerHTML = state.alertes.length ? state.alertes.map((a, i) => `
    <li><div><strong>${esc(a.nom)}</strong><div class="crit">${esc(decrireAlerte(a.filtres))}</div></div>
      <div class="row">
        <button class="small ghost" data-act="appliquer-alerte" data-i="${i}">Voir</button>
        <button class="small danger" data-act="del-alerte" data-i="${i}">Supprimer</button>
      </div></li>`).join('')
    : '<li class="muted">Aucune alerte. Règle tes filtres dans l\'onglet Recherche puis clique sur « Créer une alerte ».</li>';

  const nouvelles = nouvellesOffres();
  const badge = $('#badge-new');
  badge.hidden = !nouvelles.length;
  badge.textContent = nouvelles.length;
  document.title = (nouvelles.length ? `(${nouvelles.length}) ` : '') + 'Ma recherche d\'alternance';
  $('#liste-nouvelles').innerHTML = nouvelles.length
    ? nouvelles.slice(0, 100).map(carteOffre).join('')
    : '<div class="empty">Pas de nouvelle offre depuis ta dernière visite.</div>';

  const etat = !('Notification' in window) ? 'Ton navigateur ne gère pas les notifications.'
    : Notification.permission === 'granted' ? 'Notifications activées : tu seras prévenu dès qu\'une nouvelle offre correspond à tes alertes.'
    : Notification.permission === 'denied' ? 'Notifications bloquées. Autorise-les dans les réglages du navigateur pour ce site.'
    : 'Notifications désactivées.';
  $('#notif-etat').textContent = etat;
  $('#btn-notif').hidden = !('Notification' in window) || Notification.permission !== 'default';
}

async function verifierNouvelles(manuel = false) {
  const avant = new Set(state.offres.map((o) => o.id));
  await chargerOffres();
  if (state.premiereVisite) {
    // Première visite : on considère tout l'existant comme déjà vu pour éviter une avalanche.
    state.offres.forEach((o) => state.vues.add(o.id));
    state.premiereVisite = false;
    save();
  }
  const arrivees = state.offres.filter((o) => !avant.has(o.id) && !state.vues.has(o.id) && interesse(o));
  if (arrivees.length && avant.size && 'Notification' in window && Notification.permission === 'granted') {
    const premiere = arrivees[0];
    const n = new Notification(
      arrivees.length === 1 ? 'Nouvelle offre d\'alternance' : `${arrivees.length} nouvelles offres d'alternance`,
      { body: `${premiere.titre} · ${premiere.entreprise}${arrivees.length > 1 ? ' et d\'autres' : ''}`, tag: 'alternance' },
    );
    n.onclick = () => { window.focus(); ouvrirOnglet('alertes'); };
  }
  if (manuel) toast(nouvellesOffres().length ? `${nouvellesOffres().length} nouvelle(s) offre(s)` : 'Rien de nouveau pour le moment');
  remplirSources();
  toutRendre();
}

let minuterie = null;
function programmerVerification() {
  clearInterval(minuterie);
  const minutes = Number($('#sel-intervalle').value) || 30;
  store.set('intervalle', minutes);
  minuterie = setInterval(() => verifierNouvelles(false), minutes * 60000);
}

/* ---------- Rendu global et navigation ---------- */
function toutRendre() {
  rechercher();
  rendreEntreprises();
  rendreCandidatures();
  rendreAlertes();
}

function ouvrirOnglet(nom) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === nom));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + nom));
  store.set('onglet', nom);
  window.scrollTo({ top: 0 });
}

function brancherEvenements() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => ouvrirOnglet(b.dataset.tab)));

  let attente;
  $('#filtres').addEventListener('input', () => { clearTimeout(attente); attente = setTimeout(rechercher, 250); });
  $('#btn-reset').addEventListener('click', () => { $('#filtres').reset(); rechercher(); });
  $('#btn-save-alert').addEventListener('click', async () => {
    const filtres = lireFiltres();
    const nom = prompt('Nom de l\'alerte', decrireAlerte(filtres));
    if (!nom) return;
    const centre = filtres.ville ? await geocoder(filtres.ville) : null;
    state.alertes.push({ nom, filtres, centre });
    save();
    rendreAlertes();
    toast('Alerte créée');
  });

  $('#plat-q').addEventListener('input', () => majPlateformes(false));
  $('#plat-ville').addEventListener('input', () => majPlateformes(false));
  $('#ent-q').addEventListener('input', rendreEntreprises);

  $('#form-suivie').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    suivre(String(f.get('nom')).trim(), String(f.get('url')).trim());
    e.target.reset();
  });

  $('#form-cand').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    ajouterCandidature({ ...f, date: f.date || today() });
    e.target.reset();
    $('#form-cand [name=statut]').value = 'postule';
    toast('Candidature ajoutée');
  });
  $('#cand-filtre').addEventListener('change', rendreCandidatures);

  $('#table-cand').addEventListener('change', (e) => {
    const champ = e.target.dataset.field;
    const id = e.target.closest('tr')?.dataset.id;
    const c = state.candidatures.find((x) => x.id === id);
    if (!champ || !c) return;
    c[champ] = e.target.value;
    save();
    rendreCandidatures();
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ candidatures: state.candidatures, suivies: state.suivies, alertes: state.alertes }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `alternance-sauvegarde-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const ids = new Set(state.candidatures.map((c) => c.id));
      (data.candidatures || []).forEach((c) => { if (c && c.id && !ids.has(c.id)) state.candidatures.push(c); });
      (data.suivies || []).forEach((s) => { if (s?.nom && !estSuivie(s.nom)) state.suivies.push(s); });
      (data.alertes || []).forEach((a) => { if (a?.nom && a.filtres) state.alertes.push(a); });
      save();
      toutRendre();
      toast('Sauvegarde importée');
    } catch { toast('Fichier invalide'); }
    e.target.value = '';
  });

  $('#btn-notif').addEventListener('click', async () => {
    await Notification.requestPermission();
    rendreAlertes();
  });
  $('#sel-intervalle').addEventListener('change', programmerVerification);
  $('#btn-check').addEventListener('click', () => verifierNouvelles(true));
  $('#btn-vu').addEventListener('click', () => {
    state.offres.forEach((o) => state.vues.add(o.id));
    save();
    toutRendre();
  });

  // Actions déléguées (boutons générés dynamiquement)
  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) { e.preventDefault(); ouvrirOnglet(goto.dataset.goto); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, id, nom, i } = b.dataset;
    if (act === 'postule' || act === 'a_postuler') candidatureDepuisOffre(id, act);
    else if (act === 'suivre') suivre(nom);
    else if (act === 'unfollow') { state.suivies.splice(Number(i), 1); save(); toutRendre(); }
    else if (act === 'voir-ent') { $('#filtres').reset(); $('#filtres [name=q]').value = nom; ouvrirOnglet('recherche'); rechercher(); }
    else if (act === 'spontanee') {
      ajouterCandidature({ titre: 'Candidature spontanée', entreprise: nom, source: 'Candidature spontanée', url: b.dataset.url || '', statut: 'a_postuler' });
      toast(`${nom} ajoutée à tes candidatures`);
    } else if (act === 'del-cand') {
      const cid = b.closest('tr')?.dataset.id;
      if (confirm('Supprimer cette candidature ?')) { state.candidatures = state.candidatures.filter((c) => c.id !== cid); save(); toutRendre(); }
    } else if (act === 'del-alerte') { state.alertes.splice(Number(i), 1); save(); rendreAlertes(); }
    else if (act === 'appliquer-alerte') { ecrireFiltres(state.alertes[Number(i)].filtres); ouvrirOnglet('recherche'); rechercher(); }
  });
}

/* ---------- Démarrage ---------- */
(async function init() {
  brancherEvenements();
  if (window.matchMedia('(max-width: 820px)').matches) $('#filtres-box').open = false;
  ecrireFiltres(store.get('filtres', PAR_DEFAUT.filtres));
  $('#sel-intervalle').value = String(store.get('intervalle', 30));
  ouvrirOnglet(store.get('onglet', 'recherche'));
  await verifierNouvelles(false);
  programmerVerification();
})();
