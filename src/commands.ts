// Palette de commandes : recherche pure (testée), sans dépendance à React.

export interface Command {
  id: string;
  /** Libellé affiché et cherché. */
  label: string;
  /** Rubrique : Commands, Go to, Settings… */
  group: string;
  /** Mots en plus pour la recherche (synonymes). */
  keywords?: string;
  /** Raccourci affiché. */
  shortcut?: string;
  /** Valeur actuelle (réglages), affichée à droite. */
  value?: string;
  /** Indisponible pour l'instant (pas de film, pas d'analyse…) : affichée grisée, jamais lancée. */
  disabled?: boolean;
  run: () => void;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * Score d'un libellé pour une requête : chaque mot de la requête doit apparaître
 * (début de mot > milieu de mot). `null` : ne correspond pas.
 */
export function score(c: Pick<Command, "label" | "group" | "keywords">, query: string): number | null {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = norm(c.label);
  const hay = `${label} ${norm(c.group)} ${norm(c.keywords ?? "")}`;
  let total = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return null;
    const inLabel = label.indexOf(w);
    const startOfWord = (s: string, at: number) => at === 0 || /[\s›/(-]/.test(s[at - 1]);
    if (inLabel >= 0) total += startOfWord(label, inLabel) ? 3 : 2;
    else total += startOfWord(hay, i) ? 1 : 0.5;
  }
  return total;
}

/** Commandes qui correspondent, les meilleures d'abord ; l'ordre d'origine départage. */
export function filterCommands<T extends Pick<Command, "label" | "group" | "keywords">>(list: T[], query: string, limit = 500): T[] {
  return list
    .map((c, i) => ({ c, i, s: score(c, query) }))
    .filter((x): x is { c: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
