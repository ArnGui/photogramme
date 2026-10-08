# Photogramme 0.4 — mode d'emploi du développeur

Ce guide part de ton dossier `D:\photogramme` tel qu'il était en 0.2, et va jusqu'à la première version publiée avec mise à jour automatique. Chaque étape dit quoi taper, puis pourquoi.

Toutes les commandes se tapent dans **PowerShell**, ouvert dans `D:\photogramme` (clic droit dans le dossier › *Ouvrir dans le Terminal*).

---

## 1. Installer la nouvelle version du code

1. Ferme Photogramme et tout terminal qui tourne `npm run tauri dev`.
2. Décompresse `photogramme-0.4.zip` **par-dessus** `D:\photogramme` et accepte de remplacer les fichiers.
3. Supprime le fichier vide `cmd gits.txt` à la racine s'il est encore là.

```powershell
npm install
```

*Pourquoi :* le zip ne contient que le code. `npm install` met à jour les bibliothèques de l'interface d'après `package-lock.json`, comme un « relink » des médias après avoir copié un projet.

## 2. Vérifier que tout marche sur ta machine

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-ffmpeg.ps1
powershell -ExecutionPolicy Bypass -File scripts\run-tests.ps1
npm run tauri dev
```

*Pourquoi :* la première ligne réinstalle FFmpeg et vérifie son empreinte SHA-256 (si le fichier téléchargé avait été abîmé ou remplacé, rien ne serait installé). La deuxième lance tous les tests avec le vrai FFmpeg : environ 150 tests, tous doivent être verts. La troisième ouvre l'application en mode développement.

La première compilation Rust prend plusieurs minutes (nouvelles bibliothèques : mise à jour, PNG, XML).

**À tester à la main**, avec un vrai film :

- ouvrir un master qui commence à 01:00:00:00 : le timecode en haut doit l'afficher ;
- importer une EDL exportée de Resolve (*Extract › By shot › Edit list*) : les plans doivent tomber sur les coupes, avec les noms des clips ;
- `S` sur une image arrêtée : les scopes ; `R` puis `W` : la comparaison A/B ; `Z` : le zoom ;
- *Contact sheet* puis *MAKE CONTACT SHEET* : ouvrir le PDF obtenu ;
- un fichier tourné au téléphone (vertical) : la capture doit être debout.

Si la visionneuse et la capture n'étaient pas d'accord sur un fichier, l'application le détecte toute seule sur une image arrêtée et corrige ; un message le dit.

## 3. Le bouton Ko-fi

Ouvre `src-tauri\src\app_cmd.rs`, cherche la ligne :

```rust
pub const KOFI_HANDLE: &str = "";
```

et mets ton identifiant Ko-fi entre les guillemets (ce qui suit `ko-fi.com/`). Fais pareil dans `.github\FUNDING.yml` (retire le `#` devant `ko_fi:`).

*Pourquoi :* l'adresse est fixée dans le code Rust, pas dans l'interface : personne ne peut faire ouvrir une autre adresse à l'application. Tant que l'identifiant est vide, le bouton n'apparaît pas.

## 4. Préparer les mises à jour automatiques (une seule fois)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-updater.ps1
```

Le script te demande un mot de passe (12 caractères ou plus), puis :

- crée une paire de clés : la clé **privée** dans `C:\Users\<toi>\.tauri\photogramme-updater.key`, la clé **publique** dans `src-tauri\tauri.conf.json` ;
- range la clé privée et son mot de passe dans les *secrets* de ton dépôt GitHub, pour que le build de GitHub puisse signer l'installeur.

*Pourquoi :* chaque copie installée de Photogramme vérifie qu'une mise à jour a été signée par TA clé avant de l'installer. Sans ça, quelqu'un qui détournerait la page de téléchargement pourrait pousser n'importe quel programme sur les machines des utilisateurs.

**Important :** range le fichier `.key` ET son mot de passe dans un gestionnaire de mots de passe. Si tu les perds, les copies déjà installées ne pourront plus se mettre à jour toutes seules (il faudra retélécharger l'installeur à la main).

## 5. Épingler FFmpeg (une seule fois)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\mirror-ffmpeg.ps1
```

*Pourquoi :* les builds « latest » de BtbN changent chaque jour et les anciens sont supprimés. Le script garde une copie de l'archive exacte dans une release spéciale de ton dépôt (`ffmpeg-deps`, marquée « pre-release » pour ne jamais passer pour une version de l'application), écrit son adresse et son empreinte dans `scripts\ffmpeg.lock`, et met à jour `THIRD_PARTY_NOTICES.txt` (version, lien vers le code source exact, exigé par la licence LGPL). Tout le monde, y compris GitHub, compile alors avec le même `ffmpeg.exe`.

## 6. Publier la version 0.4.0

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.4.0 -Notes "Shots from your edit list, contact sheets, scopes, A/B compare, PNG and color profiles, automatic updates."
```

Le script :

1. vérifie que tout est prêt (connexion GitHub, clé de mise à jour, FFmpeg épinglé) ; il liste les fichiers modifiés depuis ton dernier commit et te demande de taper `YES` pour les inclure ;
2. met le numéro de version partout et lance les tests ;
3. crée le commit et le tag `v0.4.0`, et les envoie sur GitHub ;
4. suit le build sur GitHub (10 à 15 minutes) : GitHub compile l'installeur sous Windows, le signe pour les mises à jour, et prépare une release **brouillon** avec l'installeur, sa signature, `latest.json` (le fichier que lisent les copies installées) et le code source de FFmpeg ;
5. te demande de taper `PUBLISH` : la release devient publique.

*Pourquoi un brouillon :* tu peux télécharger l'installeur depuis la page de la release et l'essayer avant que le monde entier ne le reçoive.

## 7. Les versions suivantes

Code, teste, puis :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.4.1 -Notes "Ce qui a changé, en une ligne."
```

La ligne de notes s'affiche dans le bandeau de mise à jour des utilisateurs : écris-la en anglais et pour eux.

Ton ancien `publish-public.ps1` n'est plus nécessaire pour les versions : `release.ps1` et GitHub Actions le remplacent. Il reste utile pour regénérer `THIRD_PARTY_LICENSES.txt` quand tu ajoutes une bibliothèque.

## 8. Signature de code (plus tard)

L'installeur n'est pas signé : Windows SmartScreen affiche un avertissement au premier lancement (*Informations complémentaires › Exécuter quand même*). Deux pistes quand tu voudras t'en occuper :

- **SignPath Foundation** : gratuit pour les logiciels libres, build automatique sur GitHub Actions (déjà en place), dossier à déposer et validation manuelle à chaque release ;
- **Certum Open Source Code Signing** : environ 49 € par an, certificat à ton nom, signature depuis ton PC.

Depuis 2024, même un installeur signé garde l'avertissement tant que sa « réputation » auprès de Microsoft n'est pas établie par les téléchargements.

## En cas de problème

| Message | Que faire |
|---|---|
| `SHA-256 mismatch` | Le téléchargement de FFmpeg a été abîmé : relance `setup-ffmpeg.ps1`. Si ça persiste, relance `mirror-ffmpeg.ps1`. |
| `No update key yet` | Tu n'as pas fait l'étape 4. |
| `FFmpeg is not pinned yet` | Tu n'as pas fait l'étape 5. |
| `The release build failed` | Tape la commande `gh run view … --log-failed` affichée par le script et envoie les lignes rouges à Claude. |
| « Automatic updates are not set up in this build » dans Settings › About | Normal pour une version compilée chez toi sans clé : seules les versions publiées par GitHub se mettent à jour. |
