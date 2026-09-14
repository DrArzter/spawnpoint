import { Avatar } from "../components/Avatar";
import { IconButton } from "../components/ui/Button";
import { Icon } from "../icons";
import type { Game } from "../model";
import type { Theme } from "../telegram";

export function SpawnpointMark({ size = 32 }: { size?: number }) {
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
