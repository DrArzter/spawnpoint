import { formatStamp } from "../../lib/format";
import { cx } from "../../lib/cx";
import { Ghost } from "./Surfaces";

// One rendering of a moment, everywhere. A date and a clock each stay whole:
// the only place a line may break is between them, so a narrow column gives
// two readable lines instead of four ragged ones.
export function Timestamp({ value, fallback = "Unknown time", className }: Readonly<{
  value: string | number | null | undefined;
  fallback?: string;
  className?: string;
}>) {
  const stamp = formatStamp(value);
  if (stamp === null) return <Ghost>{fallback}</Ghost>;
  return (
    <time className={cx("timestamp num", className)} dateTime={stamp.iso} title={stamp.full}>
      <span>{stamp.date}</span>
      <span>{stamp.time}</span>
    </time>
  );
}
