// Icônes au trait, dessinées à la main pour rester légères (pas de bibliothèque).

type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 18 18",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const IconLogo = ({ size = 26 }: P) => (
  <svg width={size} height={size} viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
    <rect x="3" y="5" width="20" height="16" rx="1.5" />
    <path d="M7 5v16M19 5v16M3 9h4M3 13h4M3 17h4M19 9h4M19 13h4M19 17h4" />
  </svg>
);
export const IconPrevFrame = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M11 4 6 9l5 5" /></svg>
);
export const IconNextFrame = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="m7 4 5 5-5 5" /></svg>
);
export const IconBackSecond = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M9 4 4 9l5 5M15 4l-5 5 5 5" /></svg>
);
export const IconFwdSecond = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="m3 4 5 5-5 5M9 4l5 5-5 5" /></svg>
);
export const IconPlay = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="currentColor" aria-hidden><path d="M6 3.5v11l9-5.5z" /></svg>
);
export const IconPause = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="currentColor" aria-hidden>
    <rect x="4.5" y="3.5" width="3" height="11" rx="0.5" />
    <rect x="10.5" y="3.5" width="3" height="11" rx="0.5" />
  </svg>
);
export const IconCamera = ({ size = 18 }: P) => (
  <svg {...base(size)} strokeWidth={1.8}>
    <rect x="2" y="5" width="14" height="10" rx="1.5" />
    <circle cx="9" cy="10" r="2.6" />
    <path d="M6 5l1.5-2h3L12 5" />
  </svg>
);
export const IconFolder = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M2.5 5.5a1 1 0 0 1 1-1h3.2l1.5 1.6h6.3a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
);
export const IconReveal = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M10 3h5v5M15 3 8.5 9.5M13 11v3.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H7" /></svg>
);
export const IconWarning = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M9 2.8 16 15H2zM9 7.5v3.5M9 13.2v.1" /></svg>
);
export const IconSun = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <circle cx="9" cy="9" r="3.2" />
    <path d="M9 1.8v1.8M9 14.4v1.8M1.8 9h1.8M14.4 9h1.8M3.9 3.9l1.3 1.3M12.8 12.8l1.3 1.3M3.9 14.1l1.3-1.3M12.8 5.2l1.3-1.3" />
  </svg>
);
export const IconMoon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M14.6 11.2A6 6 0 0 1 6.8 3.4a6 6 0 1 0 7.8 7.8Z" /></svg>
);
