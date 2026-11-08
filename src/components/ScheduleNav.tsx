export type ScheduleNavView = 'today' | 'calendar' | 'matches' | 'messages' | 'community';

/** Fixed primary dashboard destinations — order is part of the product contract. */
export const SCHEDULE_NAV_TABS = [
  { id: 'today', label: 'Today' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'matches', label: 'Matches' },
  { id: 'messages', label: 'Messages' },
  { id: 'community', label: 'Community' },
] as const satisfies ReadonlyArray<{ id: ScheduleNavView; label: string }>;

/**
 * Primary school-run dashboard tabs.
 * Always renders all five destinations in a single visible row.
 */
export function ScheduleNav({
  view,
  onSelect,
}: {
  view: ScheduleNavView;
  onSelect: (next: ScheduleNavView) => void;
}) {
  return (
    <nav className="schedule-nav" aria-label="School run sections" data-schedule-nav="primary">
      <div
        className="schedule-tabs"
        role="tablist"
        aria-label="Today, Calendar, Matches, Messages, Community"
        data-tab-count={SCHEDULE_NAV_TABS.length}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gridAutoFlow: 'column',
        }}
      >
        <button
          type="button"
          role="tab"
          id="schedule-tab-today"
          data-schedule-tab="today"
          aria-selected={view === 'today'}
          className={view === 'today' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'}
          onClick={() => onSelect('today')}
        >
          Today
        </button>
        <button
          type="button"
          role="tab"
          id="schedule-tab-calendar"
          data-schedule-tab="calendar"
          aria-selected={view === 'calendar'}
          className={view === 'calendar' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'}
          onClick={() => onSelect('calendar')}
        >
          Calendar
        </button>
        <button
          type="button"
          role="tab"
          id="schedule-tab-matches"
          data-schedule-tab="matches"
          aria-selected={view === 'matches'}
          className={view === 'matches' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'}
          onClick={() => onSelect('matches')}
        >
          Matches
        </button>
        <button
          type="button"
          role="tab"
          id="schedule-tab-messages"
          data-schedule-tab="messages"
          aria-selected={view === 'messages'}
          className={view === 'messages' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'}
          onClick={() => onSelect('messages')}
        >
          Messages
        </button>
        <button
          type="button"
          role="tab"
          id="schedule-tab-community"
          data-schedule-tab="community"
          aria-selected={view === 'community'}
          className={view === 'community' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'}
          onClick={() => onSelect('community')}
        >
          Community
        </button>
      </div>
    </nav>
  );
}
