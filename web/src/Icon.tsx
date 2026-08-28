export type IconName = "dashboard" | "metrics" | "console" | "storage" | "access" | "play" | "stop" | "arrow" | "down" | "copy" | "external" | "plus" | "sun" | "moon" | "users" | "link";

const paths: Record<IconName, string> = {
  dashboard: "M4 4h6v6H4V4Zm10 0h6v10h-6V4ZM4 14h6v6H4v-6Zm10 4h6v2h-6v-2Z",
  metrics: "M4 18V9m5 9V5m5 13v-7m5 7V3",
  console: "m5 7 4 4-4 4m7 0h7",
  storage: "M4 7c0 2 16 2 16 0s-16-2-16 0Zm0 0v10c0 2 16 2 16 0V7m-16 5c0 2 16 2 16 0",
  access: "M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 1 2 2 4-4",
  play: "m8 5 11 7-11 7V5Z",
  stop: "M7 7h10v10H7z",
  arrow: "m9 18 6-6-6-6",
  down: "m6 9 6 6 6-6",
  copy: "M9 9h11v11H9zM4 15V4h11",
  external: "M14 4h6v6m0-6-9 9M19 14v6H4V5h6",
  plus: "M12 5v14M5 12h14",
  sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20 15.5A8 8 0 0 1 8.5 4 8 8 0 1 0 20 15.5Z",
  users: "M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm9.5 0a3 3 0 0 0 0-6m5 16v-2a4 4 0 0 0-3-3.87",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71m2.25 5.82a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const filled = name === "dashboard" || name === "play" || name === "stop";
  return (
    <svg aria-hidden="true" className="icon" fill={filled ? "currentColor" : "none"} height={size} viewBox="0 0 24 24" width={size}>
      <path d={paths[name]} stroke={filled ? "none" : "currentColor"} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}
