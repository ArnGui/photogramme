// Raccourcis clavier : quand ils s'appliquent.

/**
 * Raccourcis clavier : ignorés pendant la saisie de texte. Sur une case à
 * cocher ou un curseur (timeline comprise), seules les touches que le contrôle
 * utilise lui-même lui reviennent (Espace, flèches) ; les lettres restent des
 * raccourcis. Avant la v0.7, cliquer un interrupteur coupait tous les
 * raccourcis jusqu'au clic suivant.
 */
export function shortcutBlocked(e: { key: string; target: EventTarget | null }): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || !t.tagName) return false;
  // Élément d'une fenêtre fermée (focus pas encore rendu à la page) : ce n'est pas une saisie.
  const dialog = typeof t.closest === "function" ? (t.closest("dialog") as HTMLDialogElement | null) : null;
  if (dialog && !dialog.open) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName !== "INPUT") return false;
  const type = (t as HTMLInputElement).type;
  if (type === "checkbox" || type === "radio") return e.key === " ";
  if (type === "range") return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key);
  if (type === "color" || type === "button") return false;
  return true;
}
