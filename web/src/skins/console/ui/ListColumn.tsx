import { useEffect, useRef, type ReactNode } from "react";

import type { StatusDescriptor } from "../../../core/status";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { Avatar } from "./Avatar";
import { Status } from "./Status";

export type FilterChip = Readonly<{ id: string; label: string; count: number; pressed: boolean; onPress: () => void }>;
export type ListGroup = Readonly<{ id: string; label?: string; end?: ReactNode; items: ReactNode }>;

/**
 * The list column beside a split page: a sticky head with a filter field, an
 * optional end button and filter chips, then grouped rows. The current row is
 * kept in view, at once (no smooth scroll).
 */
export function ListColumn({ label, filter, end, chips = [], groups, empty }: Readonly<{
  label: string;
  filter: Readonly<{ value: string; set: (value: string) => void; placeholder: string }>;
  end?: ReactNode;
  chips?: readonly FilterChip[];
  groups: readonly ListGroup[];
  /** Drawn in place of the groups, when nothing matches. */
  empty?: ReactNode;
}>) {
  const column = useRef<HTMLElement>(null);
  useEffect(() => {
    column.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  });
  return (
    <nav aria-label={label} className="c-lcol" ref={column}>
      <div className="c-lcol-head">
        <div className="c-lcol-tools">
          <label className="c-lcol-search">
            <Icon name="search" size={20} />
            <input aria-label={filter.placeholder} onChange={(event) => filter.set(event.target.value)} placeholder={filter.placeholder} type="search" value={filter.value} />
          </label>
          {end}
        </div>
        {chips.length > 0 && (
          <div aria-label="Show" className="c-lcol-chips" role="group" /* NOSONAR a labelled set of toggle buttons; <fieldset> adds a frame and a legend */>
            {chips.map((chip) => (
              <button aria-pressed={chip.pressed} className="c-lcol-chip" key={chip.id} onClick={chip.onPress} type="button">
                <span>{chip.label}</span>
                <span className="c-lcol-chip-count">{chip.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {empty ?? groups.map((group) => (
        <div className="c-lcol-group" key={group.id}>
          {group.label && <div className="c-lcol-group-label"><span>{group.label}</span>{group.end}</div>}
          <ul className="c-lcol-items">{group.items}</ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * A world in the list column, on three shared tracks: name / players /
 * hosting; status / release and wipe; the address. Under 760px the name keeps
 * the first line beside the hosting chip. `standalone` carries its own tracks,
 * for a list of worlds outside the list column (the phone Worlds list).
 */
export function ListItemWorld({ href, current, name, players, hosting, status, line, address, standalone = false }: Readonly<{
  href: string;
  current: boolean;
  name: string;
  /** Players online, or null when unknown. */
  players: number | null;
  hosting: ReactNode;
  status: StatusDescriptor;
  /** Release and wipe: "1.2 · wipe #3". */
  line: string;
  address?: ReactNode;
  standalone?: boolean;
}>) {
  // A standalone row sits inside a list item of its page; in the column it is one.
  const Slot = standalone ? "div" : "li";
  return (
    <Slot className={cx("c-listitem-slot", standalone && "c-listitem-standalone")}>
      <a aria-current={current || undefined} className="c-listitem c-listitem-world" href={href}>
        <span className="c-listitem-name" title={name}>{name}</span>
        <span className="c-listitem-players">{players === null ? "" : <><Icon name="group" size={15} /><span>{players}</span></>}</span>
        <span className="c-listitem-hosting">{hosting}</span>
        <span className="c-listitem-status"><Status status={status} /></span>
        <span className="c-listitem-line" title={line}>{line}</span>
        {address && <span className="c-listitem-address">{address}</span>}
      </a>
    </Slot>
  );
}

/** A person in the list column: avatar and name with end meta (a role), the account on the second line. */
export function ListItemPerson({ href, current, name, photoUrl, meta, account, accountIcon, tone = "person" }: Readonly<{
  href: string;
  current: boolean;
  name: string;
  photoUrl?: string | null;
  meta?: ReactNode;
  account?: string;
  accountIcon?: IconName;
  tone?: "person" | "request";
}>) {
  return (
    <li className="c-listitem-slot">
      <a aria-current={current || undefined} className={cx("c-listitem", "c-listitem-person")} href={href}>
        <span className="c-listitem-who">
          <Avatar name={name} photoUrl={photoUrl} size="sm" tone={tone} />
          <span className="c-listitem-name" title={name}>{name}</span>
        </span>
        <span className="c-listitem-meta">{meta}</span>
        {account && <span className="c-listitem-account" title={account}>{accountIcon && <Icon name={accountIcon} size={15} />}<span>{account}</span></span>}
      </a>
    </li>
  );
}

/** A place in the list column that is not a person or a world: All users, Roles, My notifications. */
export function ListItemIcon({ href, current, icon, name, meta, line }: Readonly<{ href: string; current: boolean; icon: IconName; name: string; meta?: ReactNode; line?: string }>) {
  return (
    <li className="c-listitem-slot">
      <a aria-current={current || undefined} className="c-listitem c-listitem-person" href={href}>
        <span className="c-listitem-who">
          <span aria-hidden="true" className="c-listitem-icon"><Icon name={icon} size={18} /></span>
          <span className="c-listitem-name" title={name}>{name}</span>
        </span>
        <span className="c-listitem-meta">{meta}</span>
        {line && <span className="c-listitem-account" title={line}><span>{line}</span></span>}
      </a>
    </li>
  );
}
