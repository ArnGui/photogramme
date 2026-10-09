// Écran d'erreur : une erreur de rendu ne laisse jamais une fenêtre vide.
// Le travail sur le film est enregistré au fil de l'eau : recharger ne perd rien.

import { Component } from "react";
import type { ReactNode } from "react";

export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const details = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
    return (
      <main className="crash" role="alert">
        <h1 className="crash-title">PHOTOGRAMME STOPPED</h1>
        <p className="crash-text">The interface hit an error it could not recover from. Your work on the film is saved: reloading loses nothing.</p>
        <pre className="crash-details">{error.message}</pre>
        <div className="crash-actions">
          <button type="button" className="btn-primary" onClick={() => location.reload()}>Reload</button>
          <button type="button" className="btn-secondary" onClick={() => {
            void navigator.clipboard?.writeText(details).then(() => this.setState({ copied: true }), () => {});
          }}>{copied ? "Copied" : "Copy the details"}</button>
        </div>
        <p className="crash-hint">If it happens again, “Report a problem” in Preferences → About, with the copied details.</p>
      </main>
    );
  }
}
