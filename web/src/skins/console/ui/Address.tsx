import type { AddressFacts } from "../../../core/models";
import { Icon, type IconName } from "../../../icons";
import { cx } from "../../../lib/cx";
import { Copy } from "./Copy";

const glyphs: Readonly<Record<AddressFacts["connectivity"], IconName>> = { raw: "public", route53: "language", zerotier: "hub" };

/** A world's address: the network glyph (its reach in the tooltip, never a line), the mono value, an optional copy. */
export function Address({ address, copy = false, className }: Readonly<{ address: AddressFacts; copy?: boolean; className?: string }>) {
  return (
    <span className={cx("c-address", className)}>
      <span aria-label={address.network} className="c-address-glyph" data-tip={address.network} role="img" tabIndex={0 /* NOSONAR focusable tooltip trigger */}>
        <Icon name={glyphs[address.connectivity]} size={17} />
      </span>
      <span className="c-mono c-address-value" title={address.value}>{address.value}</span>
      {copy && <Copy value={address.value} what="address" />}
    </span>
  );
}
