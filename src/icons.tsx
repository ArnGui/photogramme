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
export const IconSound = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M2.5 7v4h3l4 3.2V3.8L5.5 7zM12.2 6.4a3.6 3.6 0 0 1 0 5.2M14.3 4.4a6.4 6.4 0 0 1 0 9.2" /></svg>
);
export const IconMuted = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M2.5 7v4h3l4 3.2V3.8L5.5 7zM12 7l4 4M16 7l-4 4" /></svg>
);
export const IconMoon = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M14.6 11.2A6 6 0 0 1 6.8 3.4a6 6 0 1 0 7.8 7.8Z" /></svg>
);
export const IconSearch = ({ size = 14 }: P) => (
  <svg {...base(size)}><circle cx="8" cy="8" r="5" /><path d="m12 12 4 4" /></svg>
);
export const IconGear = ({ size = 16 }: P) => (
  <svg {...base(size)} strokeWidth={1.4}>
    <path d="M14.43 7.65 L16.33 7.96 L16.33 10.04 L14.43 10.35 L13.80 11.89 L14.92 13.44 L13.44 14.92 L11.89 13.80 L10.35 14.43 L10.04 16.33 L7.96 16.33 L7.65 14.43 L6.11 13.80 L4.56 14.92 L3.08 13.44 L4.20 11.89 L3.57 10.35 L1.67 10.04 L1.67 7.96 L3.57 7.65 L4.20 6.11 L3.08 4.56 L4.56 3.08 L6.11 4.20 L7.65 3.57 L7.96 1.67 L10.04 1.67 L10.35 3.57 L11.89 4.20 L13.44 3.08 L14.92 4.56 L13.80 6.11Z" />
    <circle cx="9" cy="9" r="2.3" />
  </svg>
);
export const IconDots = ({ size = 16 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none"><circle cx="3.5" cy="9" r="1.5" /><circle cx="9" cy="9" r="1.5" /><circle cx="14.5" cy="9" r="1.5" /></svg>
);
export const IconChevron = ({ size = 12 }: P) => (
  <svg {...base(size)}><path d="m7 4 5 5-5 5" /></svg>
);
export const IconEye = ({ size = 15 }: P) => (
  <svg {...base(size)}><path d="M1.5 9S4.2 4 9 4s7.5 5 7.5 5S13.8 14 9 14 1.5 9 1.5 9z" /><circle cx="9" cy="9" r="2.2" /></svg>
);
