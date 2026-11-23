export type ScheduleNavView = 'today' | 'matches' | 'messages' | 'community';

/** Fixed primary dashboard destinations — order is part of the product contract. */
export const SCHEDULE_NAV_TABS = [
  { id: 'today', label: 'Today', shortLabel: 'Today' },
  { id: 'matches', label: 'Matches', shortLabel: 'Match' },
  { id: 'messages', label: 'Messages', shortLabel: 'Chat' },
  { id: 'community', label: 'Community', shortLabel: 'Hub' },
] as const satisfies ReadonlyArray<{ id: ScheduleNavView; label: string; shortLabel: string }>;

/** Map legacy/deep-link view values (including removed Calendar) onto a live tab. */
export function normalizeScheduleNavView(raw: string | null | undefined): ScheduleNavView {
  if (raw === 'matches' || raw === 'messages' || raw === 'community' || raw === 'today') {
    return raw;
  }
  // Removed Calendar tab (and anything unknown) → Today.
  return 'today';
}

/**
 * Primary school-run dashboard tabs.
 * Always renders all four destinations in a single visible row.
 */
export function ScheduleNav({
  view,
  onSelect,
  messagesUnread = 0,
}: {
  view: ScheduleNavView;
  onSelect: (next: ScheduleNavView) => void;
  /** Unread chat count badge on Messages (Karrot-style). */
  messagesUnread?: number;
}) {
  const badge = messagesUnread > 0
    ? (messagesUnread > 99 ? '99+' : String(messagesUnread))
    : null;

  return (
    <nav
      className="schedule-nav min-w-0 max-w-full w-full overflow-x-auto"
      aria-label="School run sections"
      data-schedule-nav="primary"
    >
      <div
        className="schedule-tabs min-w-0 max-w-full w-full"
        role="tablist"
        aria-label="Today, Matches, Messages, Community"
        data-tab-count={SCHEDULE_NAV_TABS.length}
      >
        {SCHEDULE_NAV_TABS.map((tab) => {
          const active = view === tab.id;
          const isMessages = tab.id === 'messages';
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`schedule-tab-${tab.id}`}
              data-schedule-tab={tab.id}
              aria-selected={active}
              aria-label={
                isMessages && badge
                  ? `Messages, ${badge} unread`
                  : tab.label
              }
              className={
                active
                  ? 'schedule-tab schedule-tab--active min-w-0 max-w-full'
                  : 'schedule-tab min-w-0 max-w-full'
              }
              onClick={() => onSelect(tab.id)}
            >
              <span className="schedule-tab__label schedule-tab__label--full">{tab.label}</span>
              <span className="schedule-tab__label schedule-tab__label--short" aria-hidden="true">
                {tab.shortLabel}
              </span>
              {isMessages && badge ? (
                <span className="schedule-tab__badge" aria-hidden="true">{badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
