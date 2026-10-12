# Ma recherche d'alternance

Un site personnel pour piloter sa recherche d'alternance. Il ne demande aucune installation : ce sont des fichiers HTML, CSS et JavaScript statiques, hébergeables gratuitement avec GitHub Pages.

Le site comporte quatre onglets. L'onglet Recherche filtre les offres synchronisées par mots-clés, ville et distance, type de contrat (apprentissage ou professionnalisation), niveau de diplôme, télétravail, source et date de publication. L'onglet Entreprises & plateformes ouvre la même recherche en un clic sur LinkedIn, Indeed, Welcome to the Jungle, HelloWork, France Travail, La bonne alternance, 1jeune1solution, l'Apec, JobTeaser, Walt, Glassdoor, Jobijoba et Meteojob ; il liste aussi les entreprises qui publient des offres, celles qui recrutent en alternance sans offre publiée (pour les candidatures spontanées) et les entreprises que tu suis. L'onglet Mes candidatures suit chaque candidature avec son statut, sa date, ses notes et un rappel de relance après sept jours, avec export et import en JSON. L'onglet Alertes enregistre des recherches et envoie une notification du navigateur dès qu'une nouvelle offre correspond.

## Mise en ligne avec GitHub Pages

Dans le dépôt GitHub, va dans Settings, puis Pages, choisis « Deploy from a branch », sélectionne la branche principale et le dossier racine `/`. Le site sera disponible quelques minutes plus tard à l'adresse indiquée par GitHub.

Pour l'essayer en local, lance `python3 -m http.server` dans le dossier puis ouvre http://localhost:8000.

## Récupération automatique des offres

LinkedIn, Indeed et la plupart des sites privés interdisent la récupération automatique de leurs offres, c'est pourquoi le site y renvoie par des liens de recherche préremplis. Les offres affichées directement dans le site viennent de l'API publique de La bonne alternance, le service de l'État qui regroupe les offres d'alternance de France Travail, celles de plusieurs sites partenaires et les entreprises susceptibles de recruter.

Pour l'activer, crée un compte sur https://api.apprentissage.beta.gouv.fr et génère un jeton d'accès. Ajoute-le ensuite dans le dépôt GitHub sous Settings, Secrets and variables, Actions, avec le nom `LBA_API_TOKEN`. La configuration fournie cherche des alternances de développeur web dans un rayon de 30 km autour de Lyon (codes ROME M1805 pour le développement et E1205 pour l'intégration et le webdesign). Pour la modifier, édite `config/recherche.json` : chaque recherche prend une ville, un rayon en kilomètres et une liste de codes ROME (les métiers). Quelques codes utiles : M1805 pour le développement informatique, M1810 pour le support et la production informatique, E1103 pour la communication, M1705 pour le marketing, M1203 pour la comptabilité, M1503 pour les ressources humaines, D1406 pour la vente et le commercial, M1607 pour le secrétariat et l'assistanat. La liste complète est sur le site de France Travail (« fiches ROME »).

Le workflow `.github/workflows/sync.yml` tourne alors toutes les trois heures (et à la demande depuis l'onglet Actions avec « Run workflow »). Il met à jour `data/offres.json`, que le site relit automatiquement. Les tâches planifiées de GitHub ne s'exécutent que sur la branche par défaut du dépôt, il faut donc que ces fichiers y soient fusionnés.

## Être prévenu des nouvelles offres

Quand le site est ouvert dans un onglet, il vérifie s'il y a du nouveau toutes les 15, 30 ou 60 minutes et affiche une notification du navigateur (à autoriser une fois dans l'onglet Alertes). Les entreprises suivies déclenchent toujours une notification, et les alertes enregistrées limitent les autres aux offres qui t'intéressent.

Pour être prévenu même site fermé, la synchronisation crée une issue GitHub listant les nouvelles offres. Il suffit de cliquer sur « Watch » puis « All Activity » sur le dépôt pour recevoir chaque issue par e-mail ou sur l'application mobile GitHub. On peut désactiver ce comportement avec `"creer_issue_nouvelles_offres": false` dans `config/recherche.json`.

## Où sont mes données ?

Les candidatures, les entreprises suivies et les alertes sont enregistrées dans le navigateur (localStorage). Elles ne quittent pas ton appareil, mais elles disparaissent si tu vides les données du site : utilise régulièrement le bouton Exporter de l'onglet Mes candidatures, et Importer pour les retrouver sur un autre appareil.

## Organisation des fichiers

`index.html`, `assets/style.css` et `assets/app.js` forment le site. `data/offres.json` contient les offres synchronisées. `config/recherche.json` décrit les recherches automatiques. `scripts/sync.mjs` est le script de synchronisation (Node.js 20 ou plus, sans dépendance) et `.github/workflows/sync.yml` le planifie.
