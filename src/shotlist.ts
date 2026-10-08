// Liste des plans affichée : fusions et sélection appliquées aux plans
// détectés. Pure, testée sans navigateur.

import type { ShotSpan, ShotView } from "./types";

export interface DisplayShot {
  /** Numéro d'affichage après fusions, à partir de 1. */
  index: number;
  start: number;
  end: number;
  score: number;
  /** Image de la vignette (celle du premier plan fusionné), `null` sans analyse. */
  thumb: number | null;
  /** Nom du clip (liste de montage importée). */
  clip: string | null;
  /** Le plan commence par une coupe ajoutée à la main. */
  manual: boolean;
  /** Nombre de plans détectés fusionnés dans celui-ci. */
  parts: number;
  checked: boolean;
}

/**
 * `removedCuts` : débuts de plans fusionnés avec le précédent.
 * `unchecked` : débuts des plans décochés (après fusion).
 * Les deux sont indexés par numéro d'image : ils survivent à un
 * changement de seuil tant que la coupe existe encore.
 */
export function buildShots(shots: ShotView[], removedCuts: Set<number>, unchecked: Set<number>, addedCuts: Set<number> = new Set()): DisplayShot[] {
  const out: DisplayShot[] = [];
  for (const s of shots) {
    const last = out[out.length - 1];
    if (last && removedCuts.has(s.start)) {
      last.end = s.end;
      last.parts += 1;
    } else {
      out.push({
        index: out.length + 1, start: s.start, end: s.end, score: s.score, thumb: s.thumb, clip: s.clip,
        manual: addedCuts.has(s.start), parts: 1, checked: true,
      });
    }
  }
  for (const d of out) d.checked = !unchecked.has(d.start);
  return out;
}

export function selectedSpans(list: DisplayShot[]): ShotSpan[] {
  return list.filter((s) => s.checked).map(({ index, start, end }) => ({ index, start, end }));
}

/** Fusionne le plan `i` avec le suivant. */
export function mergeWithNext(list: DisplayShot[], i: number, removedCuts: Set<number>): Set<number> {
  const next = list[i + 1];
  if (!next) return removedCuts;
  return new Set(removedCuts).add(next.start);
}

/**
 * Coupe à la main sur l'image `frame` : ajoutée (ou rétablie si elle avait
 * été fusionnée). Renvoie les nouveaux ensembles.
 */
export function cutAt(frame: number, added: Set<number>, removed: Set<number>): { added: Set<number>; removed: Set<number> } {
  if (removed.has(frame)) {
    const r = new Set(removed);
    r.delete(frame);
    return { added, removed: r };
  }
  return { added: new Set(added).add(frame), removed };
}

/** Plan contenant l'image `frame` (recherche dichotomique). */
export function shotAt(list: DisplayShot[], frame: number): number {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frame < list[mid].start) hi = mid - 1;
    else if (frame >= list[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}
