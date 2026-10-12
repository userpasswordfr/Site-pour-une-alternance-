// Synchronise les offres d'alternance depuis l'API publique La bonne alternance
// (offres France Travail, offres partenaires et entreprises qui recrutent),
// écrit data/offres.json et ouvre une issue GitHub quand de nouvelles offres arrivent.
//
// Variables d'environnement :
//   LBA_API_TOKEN      jeton de l'API api.apprentissage.beta.gouv.fr (obligatoire)
//   GITHUB_TOKEN       fourni par GitHub Actions, sert à créer l'issue (optionnel)
//   GITHUB_REPOSITORY  fourni par GitHub Actions (optionnel)

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api.apprentissage.beta.gouv.fr/api/job/v1/search';
const FICHIER = new URL('../data/offres.json', import.meta.url);
const CONFIG = new URL('../config/recherche.json', import.meta.url);
const CONSERVATION_JOURS = 45;

async function lireJson(url, defaut) {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch { return defaut; }
}

async function geocoder(ville) {
  const res = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(ville)}&fields=centre&boost=population&limit=1`);
  if (!res.ok) throw new Error(`Géocodage impossible pour ${ville} (${res.status})`);
  const [commune] = await res.json();
  if (!commune?.centre) throw new Error(`Ville introuvable : ${ville}`);
  const [lon, lat] = commune.centre.coordinates;
  return { lat, lon };
}

function villeDepuisAdresse(adresse = '') {
  const m = String(adresse).match(/\d{5}\s+(.+)$/);
  return (m ? m[1] : '').trim();
}

const REMOTE = { onsite: 'onsite', remote: 'remote', hybrid: 'hybrid' };

function normaliserOffre(j, vuLe) {
  const id = j.identifier?.id ?? j.identifier?.partner_job_id;
  if (!id) return null;
  const adresse = j.workplace?.location?.address || '';
  const [lon, lat] = j.workplace?.location?.geopoint?.coordinates || [];
  const contrat = [].concat(j.contract?.type || []).filter(Boolean);
  return {
    id: String(id),
    titre: j.offer?.title || 'Offre d\'alternance',
    entreprise: j.workplace?.brand || j.workplace?.name || j.workplace?.legal_name || 'Entreprise non précisée',
    adresse,
    ville: villeDepuisAdresse(adresse),
    lat: typeof lat === 'number' ? lat : null,
    lon: typeof lon === 'number' ? lon : null,
    contrat,
    teletravail: REMOTE[j.contract?.remote] || '',
    debut: j.contract?.start || null,
    niveau: j.offer?.target_diploma?.label || '',
    niveau_eu: j.offer?.target_diploma?.european ? String(j.offer.target_diploma.european) : '',
    rome: j.offer?.rome_codes || [],
    publie_le: j.offer?.publication?.creation || null,
    source: j.identifier?.partner_label || 'La bonne alternance',
    url: j.apply?.url || `https://labonnealternance.apprentissage.beta.gouv.fr/recherche`,
    description: String(j.offer?.description || '').replace(/\s+/g, ' ').trim().slice(0, 700),
    vu_le: vuLe,
  };
}

function normaliserRecruteur(r) {
  const id = r.identifier?.id ?? r.workplace?.siret;
  if (!id) return null;
  const adresse = r.workplace?.location?.address || '';
  return {
    id: String(id),
    nom: r.workplace?.brand || r.workplace?.name || r.workplace?.legal_name || 'Entreprise',
    secteur: r.workplace?.domain?.naf?.label || '',
    adresse,
    ville: villeDepuisAdresse(adresse),
    taille: r.workplace?.size || '',
    url: r.apply?.url || '',
  };
}

async function chercher(recherche, token) {
  const centre = await geocoder(recherche.ville);
  const params = new URLSearchParams({
    latitude: centre.lat,
    longitude: centre.lon,
    radius: recherche.rayon_km ?? 30,
  });
  if (recherche.romes?.length) params.set('romes', recherche.romes.join(','));
  if (recherche.rncp) params.set('rncp', recherche.rncp);
  if (recherche.niveau_diplome) params.set('target_diploma_level', recherche.niveau_diplome);

  const res = await fetch(`${API}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API La bonne alternance : ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { jobs: data.jobs || [], recruiters: data.recruiters || [] };
}

async function creerIssue(nouvelles, config) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  if (!config.creer_issue_nouvelles_offres || !GITHUB_TOKEN || !GITHUB_REPOSITORY || !nouvelles.length) return;
  const max = config.max_offres_par_issue || 30;
  const lignes = nouvelles.slice(0, max).map((o) =>
    `- [${o.titre}](${o.url}) chez **${o.entreprise}**${o.ville ? `, ${o.ville}` : ''}${o.contrat.length ? ` (${o.contrat.join(', ')})` : ''}`);
  if (nouvelles.length > max) lignes.push(`\n…et ${nouvelles.length - max} autres, à voir sur le site.`);
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify({
      title: `${nouvelles.length} nouvelle${nouvelles.length > 1 ? 's' : ''} offre${nouvelles.length > 1 ? 's' : ''} d'alternance`,
      body: lignes.join('\n'),
      labels: ['nouvelles-offres'],
    }),
  });
  if (!res.ok) console.warn(`Issue non créée : ${res.status} ${await res.text()}`);
}

async function main() {
  const token = process.env.LBA_API_TOKEN;
  if (!token) {
    console.log('LBA_API_TOKEN absent : synchronisation ignorée. Voir le README pour obtenir un jeton.');
    return;
  }
  const config = await lireJson(CONFIG, { recherches: [] });
  const precedent = await lireJson(FICHIER, { offres: [], recruteurs: [] });
  const dejaVues = new Map(precedent.offres.map((o) => [o.id, o]));
  const maintenant = new Date().toISOString();

  const offres = new Map();
  const recruteurs = new Map();
  let echecs = 0;
  for (const r of config.recherches) {
    try {
      const { jobs, recruiters } = await chercher(r, token);
      for (const j of jobs) {
        const o = normaliserOffre(j, maintenant);
        if (!o || offres.has(o.id)) continue;
        if (dejaVues.has(o.id)) o.vu_le = dejaVues.get(o.id).vu_le;
        offres.set(o.id, o);
      }
      for (const rc of recruiters) {
        const e = normaliserRecruteur(rc);
        if (e && !recruteurs.has(e.id)) recruteurs.set(e.id, e);
      }
      console.log(`${r.nom} : ${jobs.length} offres, ${recruiters.length} entreprises`);
    } catch (err) {
      echecs++;
      console.error(`${r.nom} : ${err.message}`);
    }
  }
  if (echecs === config.recherches.length && echecs > 0) {
    // Tout a échoué : on garde les données précédentes plutôt que de tout effacer.
    process.exitCode = 1;
    return;
  }

  // On garde quelque temps les offres disparues des résultats (l'API ne renvoie qu'une page).
  const limite = Date.now() - CONSERVATION_JOURS * 86400000;
  for (const o of precedent.offres) {
    if (!offres.has(o.id) && new Date(o.vu_le).getTime() > limite) offres.set(o.id, o);
  }

  const nouvelles = [...offres.values()].filter((o) => !dejaVues.has(o.id));
  const premiereSynchro = precedent.offres.length === 0;

  await writeFile(FICHIER, JSON.stringify({
    mis_a_jour: maintenant,
    offres: [...offres.values()],
    recruteurs: [...recruteurs.values()].slice(0, 500),
  }, null, 1) + '\n');

  console.log(`${offres.size} offres au total, ${nouvelles.length} nouvelles.`);
  if (!premiereSynchro) await creerIssue(nouvelles, config);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
