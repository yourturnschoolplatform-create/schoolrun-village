import type { ScheduleNavView } from './ScheduleNav';

export type QuickActionFocus = 'instant' | 'discussions' | 'market' | 'trust' | 'relay' | 'deals';

const ACTIONS: Array<{
  id: string;
  label: string;
  hint: string;
  icon: string;
  view: ScheduleNavView;
  focus: QuickActionFocus;
}> = [
  { id: 'instant', label: 'Instant Pickup', hint: 'School run / carpool', icon: '🚗', view: 'today', focus: 'instant' },
  { id: 'discussions', label: 'Discussions', hint: 'Age-stage & school tips', icon: '💬', view: 'community', focus: 'discussions' },
  { id: 'market', label: 'Marketplace', hint: 'Kids secondhand & sell', icon: '🛒', view: 'community', focus: 'market' },
  { id: 'trust', label: 'Parent Trust', hint: 'Trust band & verify', icon: '🛡️', view: 'community', focus: 'trust' },
  { id: 'relay', label: 'Relay Share', hint: 'Free share & swap', icon: '🎁', view: 'community', focus: 'relay' },
  { id: 'deals', label: 'Hot Deals', hint: 'Group-buy & brand offers', icon: '🛍️', view: 'community', focus: 'deals' },
];

/**
 * One-tap shortcuts for core SchoolRun Village modules (Discussions early for discoverability).
 * Mobile: strict 2-column grid with minmax(0,1fr) so right-column cards never clip.
 */
export function QuickActions({
  onSelect,
}: {
  onSelect: (view: ScheduleNavView, focus?: QuickActionFocus) => void;
}) {
  return (
    <div
      className="quick-actions min-w-0 max-w-full w-full overflow-hidden"
      role="navigation"
      aria-label="Quick actions"
      data-quick-actions="ready"
    >
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className="quick-action box-border min-w-0 max-w-full w-full overflow-hidden"
          data-quick-action={action.id}
          onClick={() => onSelect(action.view, action.focus)}
        >
          <span className="quick-action__icon" aria-hidden="true">{action.icon}</span>
          <span className="quick-action__label">{action.label}</span>
          <span className="quick-action__hint">{action.hint}</span>
        </button>
      ))}
    </div>
  );
}
