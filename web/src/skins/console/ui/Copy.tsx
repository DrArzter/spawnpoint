import { useEffect, useState } from "react";

import { Icon } from "../../../icons";
import { cx } from "../../../lib/cx";
import { MOTION } from "./motion";
import { t } from "../../../i18n";

/** Copies one value. The icon turns to a check for a moment and "Copied" is announced; no toast. */
export function Copy({ value, what, className }: Readonly<{ value: string; /** What is copied, for the name: "address", "world ID". */ what: string; className?: string }>) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), MOTION["--c-dwell-copy"]);
    return () => window.clearTimeout(timer);
  }, [done]);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => setDone(true), () => undefined);
  };
  return (
    <button aria-label={t("ui.copyWhat", { what })} className={cx("c-copy", done && "c-copy-done", className)} data-tip={done ? t("ui.copied") : t("ui.copy")} onClick={copy} type="button">
      <Icon name={done ? "check" : "content_copy"} size={17} />
      <span aria-live="polite" className="c-sr">{done ? t("ui.copied") : ""}</span>
    </button>
  );
}
