import { Avatar } from "../components/Avatar";
import { IconButton } from "../components/ui/Button";
import { Icon } from "../icons";
import type { Game } from "../model";
import type { Theme } from "../telegram";

export function SpawnpointMark({ size = 32 }: { size?: number }) {
  // The mark: a spawn point seen from above, a ring with a settled centre.
  return (
    <span aria-hidden="true" className="mark" style={{ width: size, height: size, borderRadius: size / 4 }}>
      <svg fill="none" height={size * 0.62} viewBox="0 0 24 24" width={size * 0.62}>
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" fill="currentColor" r="3.2" />
        <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    </span>
  );
}

export function AppBar({ game, onMenu, onScope, scopeDisabled, theme, themeLabel, onTheme, viewerName, viewerPhoto, onProfile, preview }: {
  game: Game | undefined;
  onMenu: () => void;
  onScope: () => void;
  scopeDisabled: boolean;
  theme: Theme;
  themeLabel: string;
  onTheme: () => void;
  viewerName: string;
  viewerPhoto?: string | null;
  onProfile: () => void;
  preview: boolean;
}) {
  return (
    <header className="appbar">
      <IconButton icon="menu" label="Toggle navigation" onClick={onMenu} />
      <a className="appbar-brand" href="#/worlds">
        <SpawnpointMark />
        <strong>Spawnpoint</strong>
      </a>
      <span aria-hidden="true" className="appbar-divider" />
      <button aria-haspopup="dialog" className="appbar-scope" disabled={scopeDisabled} onClick={onScope} title="Select a game" type="button">
        <Icon name="sports_esports" size={20} />
        <span>{game?.displayName ?? "No game"}</span>
        <Icon name="unfold_more" size={18} />
      </button>
      <span className="appbar-spacer" />
      <div className="appbar-actions">
        {preview && <span className="preview-badge" title="Fixture data from src/preview.ts, no backend calls"><Icon name="warning" size={14} /><span>Preview data</span></span>}
        <IconButton icon={theme === "dark" ? "light_mode" : "dark_mode"} label={`${themeLabel}. Change theme`} onClick={onTheme} />
        <button aria-label="Open my profile" className="appbar-avatar" onClick={onProfile} title={viewerName} type="button">
          <Avatar name={viewerName} photoUrl={viewerPhoto} />
        </button>
      </div>
    </header>
  );
}
