import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Action } from "../../../core/actions";
import type { ShellModel } from "../../../core/models";
import type { StatusDescriptor } from "../../../core/status";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { Status } from "./Status";

type Option = Readonly<{
  key: string;
  group: "Go to" | "Worlds" | "Actions";
  label: string;
  icon: IconName;
  href?: string;
  action?: Action;
  status?: StatusDescriptor;
}>;

const pageIcons: Readonly<Record<string, IconName>> = { worlds: "public", releases: "inventory", access: "group" };

// What the palette offers, from what the shell model holds. A world's verbs
// are asked for only while it is open, so a closed palette holds no Action.
export function paletteOptions(model: ShellModel): Option[] {
  const go: Option[] = [];
  if (model.overview) go.push({ key: "go.home", group: "Go to", label: "Home", icon: "home", href: model.overview.href });
  for (const item of model.navigation) {
    if (item.id === "profile") continue;
    go.push({ key: `go.${item.id}`, group: "Go to", label: item.label, icon: pageIcons[item.id] ?? "chevron_right", href: item.href });
    if (item.id === "access") {
      go.push(
        { key: "go.access.roles", group: "Go to", label: "Access › Roles", icon: "admin_panel_settings", href: "#/access/roles" },
        { key: "go.access.notifications", group: "Go to", label: "Access › My notifications", icon: "notifications", href: "#/access/notifications" },
      );
    }
  }
  go.push({ key: "go.profile", group: "Go to", label: "Profile", icon: "person", href: "#/profile" });
  const refresh = model.refreshAction?.();
  if (refresh) go.push({ key: "go.refresh", group: "Go to", label: refresh.label, icon: "refresh", action: refresh });
  const worlds = model.worlds ?? [];
  const places: Option[] = worlds.map((world) => ({ key: `world.${world.id}`, group: "Worlds", label: world.name, icon: "public", href: world.href, status: world.status }));
  const verbs: Option[] = worlds.flatMap((world) => {
    const actions = model.worldActions?.(world.id);
    if (!actions) return [];
    return [actions.session, ...(actions.invite ? [actions.invite] : [])].map((item) => ({
      key: `act.${world.id}.${item.id}`, group: "Actions" as const, label: `${item.label} ${world.name}`, icon: item.icon ?? "chevron_right", action: item,
    }));
  });
  return [...go, ...places, ...verbs];
}

function matches(option: Option, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${option.label} ${option.group}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

// A refused verb ranks below the ones that can run.
function ranked(options: readonly Option[]): Option[] {
  return [...options].sort((a, b) => Number(a.action?.disabled === true) - Number(b.action?.disabled === true));
}

/**
 * Search and run: places and the scoped game's worlds, and each world's own
 * Start, Stop and Invite. A refused verb shows its reason, shakes on Enter
 * and announces the reason; it never runs.
 */
export function Palette({ model, onClose }: Readonly<{ model: ShellModel; onClose: () => void }>) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [refused, setRefused] = useState<{ key: string; hint: string; at: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const all = useMemo(() => paletteOptions(model), [model]);
  const shown = query.trim() === "" ? all : ranked(all.filter((option) => matches(option, query)));
  const groups = (["Go to", "Worlds", "Actions"] as const).map((group) => ({ group, options: shown.filter((option) => option.group === group) })).filter((group) => group.options.length > 0);
  const flat = groups.flatMap((group) => group.options);
  const at = Math.min(active, Math.max(flat.length - 1, 0));

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => { document.getElementById(`${listId}-${at}`)?.scrollIntoView({ block: "nearest" }); }, [at, listId]);

  const run = (option: Option | undefined) => {
    if (!option) return;
    if (option.action?.disabled) {
      setRefused({ key: option.key, hint: option.action.hint ?? "Unavailable", at: Date.now() });
      return;
    }
    onClose();
    if (option.action) option.action.run();
    else if (option.href) window.location.hash = option.href.replace(/^#/, "");
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length > 0) setActive((at + (event.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(flat[at]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let index = -1;
  return (
    <>
      <div aria-hidden="true" className="c-palette-scrim" onPointerDown={onClose} />
      <div aria-label="Search and run" aria-modal="true" className="c-palette" role="dialog" /* NOSONAR the palette keeps focus in its input and draws its own scrim; <dialog> would take focus */>
        <div className="c-palette-input">
          <Icon name="search" size={20} />
          <input
            aria-activedescendant={flat.length > 0 ? `${listId}-${at}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-label="Search or run"
            autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={onKey}
            placeholder="Search or run"
            ref={input}
            role="combobox"
            spellCheck={false}
            value={query}
          />
          <kbd>Esc</kbd>
        </div>
        <div aria-label="Results" className="c-palette-list" id={listId} role="listbox">
          {groups.map(({ group, options }) => (
            <div aria-label={group} key={group} role="group">
              <div aria-hidden="true" className="c-palette-group">{group}</div>
              {options.map((option) => {
                index += 1;
                const mine = index;
                const disabled = option.action?.disabled === true;
                return (
                  <div
                    aria-disabled={disabled || undefined}
                    aria-selected={mine === at}
                    className={cx("c-palette-option", refused?.key === option.key && "c-palette-refused")}
                    data-action={option.action?.id}
                    id={`${listId}-${mine}`}
                    key={refused?.key === option.key ? `${option.key}:${refused.at}` : option.key}
                    onMouseDown={(event) => { event.preventDefault(); run(option); }}
                    onMouseMove={() => setActive(mine)}
                    role="option" // NOSONAR options are chosen through aria-activedescendant; focus stays on the input
                  >
                    <span className="c-palette-icon">{disabled ? <Icon name="lock" size={18} /> : <Icon name={option.icon} size={18} />}</span>
                    <span className="c-palette-label">{option.label}</span>
                    <span className="c-palette-end">
                      {disabled && <span className="c-palette-why">{option.action?.hint}</span>}
                      {option.status && <Status status={option.status} />}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <div className="c-palette-none">No matches</div>}
        </div>
        <div aria-live="assertive" className="c-sr">{refused?.hint}</div>
      </div>
    </>
  );
}
