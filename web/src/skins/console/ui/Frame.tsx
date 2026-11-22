import type { ReactNode } from "react";

import type { NavigationItem, ShellModel } from "../../../core/models";
import { Icon, type IconName } from "../../../icons";
import { Avatar } from "./Avatar";
import { relativeTime } from "./Ago";
import { ActionButton } from "./ActionButton";
import { useNow } from "./Flashbar";
import { IconButton } from "./IconButton";

/*
 * The frame: the top bar, the rail at 760px and up, the bottom bar under it.
 * None of them moves on a page switch; only the page area does (A1).
 */

const icons: Readonly<Record<string, IconName>> = { home: "home", worlds: "public", releases: "inventory", access: "group", profile: "person" };

export type FrameItem = Readonly<{ key: string; label: string; href: string; current: boolean; badge?: number; divider?: boolean }>;

/** The destinations, in rail order. Home is current on the overview; Worlds only on the list and a world's page. */
export function frameItems(model: ShellModel): FrameItem[] {
  const home = model.overview;
  const nav = (item: NavigationItem): FrameItem => ({
    key: item.id,
    label: item.label,
    href: item.href,
    current: item.current && !(item.id === "worlds" && home?.current),
    ...(item.id === "access" && typeof model.requests === "number" && model.requests > 0 ? { badge: model.requests } : {}),
    divider: item.id === "access",
  });
  const pages = model.navigation.filter((item) => item.id !== "profile").map(nav);
  return [
    ...(home ? [{ key: "home", label: "Home", href: home.href, current: home.current }] : []),
    ...pages,
    { key: "profile", label: "Profile", href: "#/profile", current: model.page === "profile", divider: !pages.some((item) => item.key === "access") },
  ];
}

export function Mark() {
  return (
    <span aria-hidden="true" className="c-mark">
      <svg fill="currentColor" height="18" viewBox="0 0 24 24" width="18">
        <path d="M12 3 20.5 7.9v8.2L12 21l-8.5-4.9V7.9L12 3Z" opacity="0.4" />
        <path d="M12 3l8.5 4.9L12 12.8 3.5 7.9 12 3Z" />
      </svg>
    </span>
  );
}

function NavLink({ item, place }: Readonly<{ item: FrameItem; place: "rail" | "bottom" }>) {
  return (
    <a aria-current={item.current ? "page" : undefined} className={place === "rail" ? "c-rail-item" : "c-bottom-item"} href={item.href}>
      <span className="c-nav-icon">
        <span aria-hidden="true" className="c-nav-pill" data-layer="glyph" />
        {/* Its own transition layer, so the moving pill passes under it (A1n). */}
        <span className="c-nav-glyph" style={{ viewTransitionName: `c-${place}-${item.key}` }}><Icon name={icons[item.key] ?? "chevron_right"} size={22} /></span>
      </span>
      <span className="c-nav-label">{item.label}</span>
      {item.badge !== undefined && <span aria-label={`${item.badge} requests`} className="c-badge" data-layer="glyph">{item.badge}</span>}
    </a>
  );
}

export function Rail({ model }: Readonly<{ model: ShellModel }>) {
  return (
    <nav aria-label="Main navigation" className="c-rail">
      {frameItems(model).map((item) => (
        <span className="c-rail-slot" key={item.key}>
          {item.divider && <hr className="c-rail-divider" />}
          <NavLink item={item} place="rail" />
        </span>
      ))}
    </nav>
  );
}

export function BottomBar({ model }: Readonly<{ model: ShellModel }>) {
  return (
    <nav aria-label="Main navigation" className="c-bottom">
      {frameItems(model).map((item) => <NavLink item={item} key={item.key} place="bottom" />)}
    </nav>
  );
}

function Refreshed({ model }: Readonly<{ model: ShellModel }>) {
  const now = useNow(model.observedAtIso !== undefined);
  const refresh = model.refreshAction?.();
  if (!refresh || !model.observedAtIso) return null;
  const ago = relativeTime(model.observedAtIso, now);
  return (
    <span className="c-refreshed">
      <span className="c-refreshed-text"><Icon name="schedule" size={17} /><span>Refreshed {ago}</span></span>
      <ActionButton action={{ ...refresh, label: `Refresh · Refreshed ${ago}` }} className="c-band-btn" iconOnly />
    </span>
  );
}

/** The top bar: brand and game at the start; search, refreshed time, demo and the account at the end. No theme control (R7). */
export function TopBar({ model, scope, onSearch }: Readonly<{ model: ShellModel; scope: ReactNode; onSearch: () => void }>) {
  return (
    <header className="c-topbar">
      <a className="c-brand" href={model.overview?.href ?? "#/worlds"}>
        <Mark />
        <span className="c-brand-name">Spawnpoint</span>
      </a>
      {scope}
      <span className="c-topbar-gap" />
      <button aria-keyshortcuts="Control+K Meta+K /" className="c-search" onClick={onSearch} type="button">
        <Icon name="search" size={18} />
        <span className="c-search-text">Search</span>
        <kbd>Ctrl K</kbd>
      </button>
      <IconButton className="c-search-icon" icon="search" label="Search" onClick={onSearch} tone="band" />
      <Refreshed model={model} />
      {model.demo && <span className="c-demo">Demo</span>}
      <button aria-label={model.openProfile.label} className="c-account" data-action={model.openProfile.id} data-tip={model.viewer.displayName} onClick={model.openProfile.run} type="button">
        <Avatar name={model.viewer.displayName} photoUrl={model.viewer.photoUrl} size="md" />
      </button>
    </header>
  );
}
