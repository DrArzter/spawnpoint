import { Tooltip } from "../components/ui/Tooltip";
import { Icon } from "../icons";
import { t } from "../i18n";

export function SpawnpointMark({ size = 32 }: Readonly<{ size?: number }>) {
  // The mark: one block seen from above, the spawn point set on its top face.
  return (
    <span aria-hidden="true" className="mark" style={{ width: size, height: size, borderRadius: size / 4 }}>
      <svg fill="currentColor" height={size * 0.72} viewBox="0 0 24 24" width={size * 0.72}>
        <path d="M12 3 20.5 7.9v8.2L12 21l-8.5-4.9V7.9L12 3Z" opacity="0.32" />
        <path d="M12 3l8.5 4.9L12 12.8 3.5 7.9 12 3Z" />
        <path d="M3.5 7.9 12 12.8V21l-8.5-4.9V7.9Z" opacity="0.78" />
        <path d="M20.5 7.9 12 12.8V21l8.5-4.9V7.9Z" opacity="0.5" />
        <circle cx="12" cy="7.9" fill="var(--primary)" r="2.2" />
      </svg>
    </span>
  );
}

// Whose data this is, shown wherever a session is. A fact about the session,
// so no screen has to ask which mode the panel is running in.
export function DemoBadge() {
  return (
    <Tooltip text={t("shell.demoDataLivesTab")}>
      <span className="demo-badge">
        <Icon name="warning" size={14} />
        <span>{t("shell.demoData")}</span>
      </span>
    </Tooltip>
  );
}
