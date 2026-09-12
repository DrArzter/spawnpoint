import { Icon, IconName } from "../icons";
import type { Page } from "../model";

export type NavItem = { id: Page; label: string; icon: IconName; href: string };

export function NavDrawer({ items, current, footer, onNavigate }: {
  items: readonly NavItem[];
  current: Page;
  footer?: { label: string; value: string };
  onNavigate: () => void;
}) {
  return (
    <aside className="drawer" id="navigation-drawer">
      <nav aria-label="Main navigation">
        {items.map((item) => (
          <a aria-current={current === item.id ? "page" : undefined} className="drawer-item" href={item.href} key={item.id} onClick={onNavigate} title={item.label}>
            <Icon name={item.icon} size={22} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
      {footer && (
        <div className="drawer-footer">
          {footer.label}
          <strong>{footer.value}</strong>
        </div>
      )}
    </aside>
  );
}
