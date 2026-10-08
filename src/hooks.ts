import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VideoInfo } from "./types";

// requestVideoFrameCallback : présent dans Chromium/WebView2, pas toujours typé.
interface FrameMeta {
  mediaTime: number;
}
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Lecteur à l'image près.
 *
 * Le `currentTime` d'une balise <video> n'est pas fiable à l'image près.
 * `requestVideoFrameCallback` donne le timestamp exact de l'image réellement
 * affichée : c'est lui qui fait foi pour la capture.
 * Pour se placer sur l'image n, on vise le milieu de son intervalle,
 * (n + 0,5) / fps, pour ne jamais tomber sur la voisine.
 */
/**
 * `offset` : correction mesurée (voir `sync.ts`) : l'image affichée sous le
 * numéro brut N est l'image N + offset du fichier. `mountKey` change quand
 * la balise <video> est recréée.
 */
export function usePlayer(info: VideoInfo | null, offset = 0, mountKey = 0) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrameState] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Vitesse de navette : > 0 avant, < 0 arrière, 0 arrêt (J/K/L). */
  const [shuttleSpeed, setShuttleSpeed] = useState(0);
  const frameRef = useRef(0);
  const reverseTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const setFrame = useCallback((f: number) => {
    frameRef.current = f;
    setFrameState(f);
  }, []);

  const clamp = useCallback(
    (f: number) => (info ? Math.min(info.frameCount - 1, Math.max(0, Math.round(f))) : 0),
    [info],
  );
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  useEffect(() => {
    setFrame(0);
    setPlaying(false);
    const v = videoRef.current as VideoWithRvfc | null;
    if (!v || !info) return;
    const fps = info.fpsNum / info.fpsDen;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);

    let cancelled = false;
    let handle = 0;
    let cleanupFallback = () => {};

    if (typeof v.requestVideoFrameCallback === "function") {
      const cb = (_now: number, meta: FrameMeta) => {
        if (cancelled) return;
        setFrame(clamp(meta.mediaTime * fps + offsetRef.current));
        handle = v.requestVideoFrameCallback!(cb);
      };
      handle = v.requestVideoFrameCallback(cb);
    } else {
      const onTime = () => setFrame(clamp(Math.floor(v.currentTime * fps) + offsetRef.current));
      v.addEventListener("timeupdate", onTime);
      v.addEventListener("seeked", onTime);
      cleanupFallback = () => {
        v.removeEventListener("timeupdate", onTime);
        v.removeEventListener("seeked", onTime);
      };
    }

    return () => {
      cancelled = true;
      v.cancelVideoFrameCallback?.(handle);
      cleanupFallback();
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
    };
  }, [info, clamp, setFrame, mountKey]);

  const seek = useCallback(
    (f: number) => {
      const v = videoRef.current;
      if (!v || !info) return;
      const target = clamp(f);
      v.currentTime = ((Math.max(0, target - offsetRef.current) + 0.5) * info.fpsDen) / info.fpsNum;
      setFrame(target);
    },
    [info, clamp, setFrame],
  );

  const stopReverse = useCallback(() => {
    clearInterval(reverseTimer.current);
    reverseTimer.current = undefined;
  }, []);
  useEffect(() => stopReverse, [stopReverse, info]);

  const step = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      stopReverse();
      setShuttleSpeed(0);
      if (v && !v.paused) v.pause();
      seek(frameRef.current + delta);
    },
    [seek, stopReverse],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    stopReverse();
    setShuttleSpeed(0);
    v.playbackRate = 1;
    if (v.paused) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [stopReverse]);

  /**
   * Navette J/K/L : L lit en avant (×1, ×2, ×4, ×8 à chaque appui), J en
   * arrière, K arrête. La balise <video> ne sait pas lire à l'envers : la
   * marche arrière avance par sauts d'images à la cadence du film.
   */
  const shuttle = useCallback(
    (dir: -1 | 0 | 1) => {
      const v = videoRef.current;
      if (!v || !info) return;
      stopReverse();
      if (dir === 0) {
        v.pause();
        v.playbackRate = 1;
        setShuttleSpeed(0);
        return;
      }
      setShuttleSpeed((cur) => {
        const same = Math.sign(cur) === dir;
        const next = same ? Math.min(8, Math.abs(cur) * 2) : 1;
        if (dir > 0) {
          v.playbackRate = next;
          if (v.paused) void v.play().catch(() => setPlaying(false));
        } else {
          v.pause();
          const fps = info.fpsNum / info.fpsDen;
          // Au plus ~25 sauts par seconde : chaque saut avance de plusieurs images à grande vitesse.
          const hz = Math.min(fps, 25);
          const per = Math.max(1, Math.round((fps * next) / hz));
          reverseTimer.current = setInterval(() => {
            const f = frameRef.current - per;
            seek(f);
            if (f <= 0) {
              stopReverse();
              setShuttleSpeed(0);
            }
          }, 1000 / hz);
        }
        return dir * next;
      });
    },
    [info, seek, stopReverse],
  );

  return { videoRef, frame, frameRef, playing: playing || shuttleSpeed < 0, shuttleSpeed, seek, step, togglePlay, shuttle };
}

/** Plus grand rectangle au ratio donné tenant dans le conteneur. */
export function useFitBox(ref: RefObject<HTMLElement | null>, aspect: number) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      const w = Math.min(width, height * aspect);
      setBox({ w: Math.floor(w), h: Math.floor(w / aspect) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, aspect]);
  return box;
}

/** Valeur retardée : ne change qu'après `ms` d'immobilité. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Largeur réelle d'un élément, suivie au redimensionnement. */
export function useWidth(ref: RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
