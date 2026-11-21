import type { Detail, DetailKey, DetailValue } from "../../../core/models";
import { Icon } from "../../../icons";
import { cx } from "../../../lib/cx";
import { Address } from "./Address";
import { Ago } from "./Ago";
import { Chip } from "./Chip";
import { Copy } from "./Copy";
import { Status } from "./Status";

const dayTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** `d MMM HH:mm`, or null for an unknown time. */
export function shortDateTime(at: string | number | null | undefined): string | null {
  const time = typeof at === "number" ? at : at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? null : dayTime.format(time);
}

/** One value of a detail, drawn by its kind. */
export function DetailValueView({ value }: Readonly<{ value: DetailValue }>) {
  switch (value.type) {
    case "text": return <span className={cx("c-detail-text", value.mono && "c-mono")} title={value.text}>{value.text}</span>;
    case "absent": return <span className="c-faint c-detail-text">{value.text}</span>;
    case "status": return <Status status={value.status} />;
    case "number": return <span>{value.value}</span>;
    case "time": {
      const text = shortDateTime(value.at);
      if (text === null) return <span className="c-faint">—</span>;
      return <span className="c-detail-time"><span>{text}</span><span className="c-faint"><Ago at={value.at} /></span></span>;
    }
    case "release":
      if (value.active === null && value.desired === null) return <span className="c-faint">—</span>;
      return (
        <span className="c-detail-release">
          <span className="c-mono">{value.active ?? "—"}</span>
          {value.desired !== null && value.desired !== value.active && <Chip tip={`Desired ${value.desired}`}>→ {value.desired}</Chip>}
        </span>
      );
    case "address": return <Address address={value.address} />;
    case "preset":
      return (
        <span className="c-detail-preset">
          <span className="c-detail-text">{value.name}</span>
          {value.source && <a className="c-mono c-faint" href={value.source.href} rel="noreferrer" target="_blank" title={value.source.commit}>@{value.source.short}</a>}
        </span>
      );
  }
}

export type DetailColumns = "four" | "two" | "fit";
export type DetailSpan = "w2" | "full";

/**
 * Key-value facts in equal columns: four (two under 1200px), always two, or
 * as many 220px columns as fit. A label sits above its value; a hint is a
 * faint line under the value, cut with an ellipsis and whole in its tooltip;
 * an explanation is the tooltip of an info mark.
 */
export function DetailList({ details, columns = "four", omit = [], spans = {}, label }: Readonly<{
  details: readonly Detail[];
  columns?: DetailColumns;
  /** Facts this view shows elsewhere (R3), by key. */
  omit?: readonly DetailKey[];
  /** Wider entries, by key, or by label for a detail a page builds without a key. */
  spans?: Readonly<Partial<Record<DetailKey | string, DetailSpan>>>;
  label?: string;
}>) {
  const shown = details.filter((detail) => detail.key === undefined || !omit.includes(detail.key));
  return (
    <dl aria-label={label} className={cx("c-detail", `c-detail-${columns}`)}>
      {shown.map((detail) => {
        const span = (detail.key ? spans[detail.key] : undefined) ?? spans[detail.label];
        return (
          <div className={cx("c-detail-item", span && `c-span-${span}`)} key={detail.key ?? detail.label}>
            <dt>
              <span>{detail.label}</span>
              {detail.explain && <span aria-label={detail.explain} className="c-detail-explain" data-tip={detail.explain} role="img" tabIndex={0}><Icon name="info" size={15} /></span>}
            </dt>
            <dd>
              <span className="c-detail-value">
                <DetailValueView value={detail.value} />
                {detail.copy && <Copy value={detail.copy} what={detail.label} />}
              </span>
              {(detail.hint || (detail.hintTime !== undefined && detail.hintTime !== null)) && (
                <span className={cx("c-detail-hint", detail.hintAttention && "c-tone-warn")} data-tip={detail.hint} tabIndex={detail.hint ? 0 : undefined}>
                  {detail.hintAttention && <Icon name="warning" size={15} />}
                  <span className="c-detail-hint-text">
                    {detail.hint}
                    {detail.hint && detail.hintTime !== undefined && detail.hintTime !== null && " "}
                    {detail.hintTime !== undefined && detail.hintTime !== null && <Ago at={detail.hintTime} />}
                  </span>
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
