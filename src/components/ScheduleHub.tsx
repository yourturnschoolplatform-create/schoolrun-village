import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  directionLabelEnglish,
  intentLabelEnglish,
  statusLabelEnglish,
} from '../../shared/au-location';
import { addDays, dateInPeriod, isSuburbAreaLabel, shortWeekday, type SchoolRunDirection, type ScheduleIntent } from '../../shared/schedules';
import { scheduleApi, type ScheduleOverview, type SchedulePattern, type SchedulePatternInput } from '../lib/schedule-api';
import type { ChatRoom } from '../lib/chat-api';
import { ChatHub } from './ChatHub';
import { CommunityHub } from './CommunityHub';
import { InstantPickupBoard } from './InstantPickupBoard';
import { MatchHub } from './MatchHub';
import { QuickActions, type QuickActionFocus } from './QuickActions';
import { ScheduleNav, type ScheduleNavView } from './ScheduleNav';
import type { CommunityPanel } from './CommunityHub';

type ViewMode = ScheduleNavView;

type PatternForm = SchedulePatternInput;

function schoolLocalDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (kind: string) => parts.find((item) => item.type === kind)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const WEEKDAY_CHIPS = [
  { value: 1, label: 'M', title: 'Monday' },
  { value: 2, label: 'T', title: 'Tuesday' },
  { value: 3, label: 'W', title: 'Wednesday' },
  { value: 4, label: 'T', title: 'Thursday' },
  { value: 5, label: 'F', title: 'Friday' },
] as const;

const TIME_PRESETS = [
  { id: 'morning', label: '08:00 – 08:30', start: '08:00', end: '08:30' },
  { id: 'afternoon', label: '15:00 – 15:30', start: '15:00', end: '15:30' },
] as const;

function initialForm(startsOn = schoolLocalDate(), areaLabel = ''): PatternForm {
  return { intent: 'can_help', direction: 'dropoff', weekday: 1, windowStart: '08:00', windowEnd: '08:30', areaLabel, capacity: 1, startsOn };
}

function matchTimePreset(start: string, end: string): 'morning' | 'afternoon' | 'custom' {
  if (start === '08:00' && end === '08:30') return 'morning';
  if (start === '15:00' && end === '15:30') return 'afternoon';
  return 'custom';
}

function displayDate(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone }).format(new Date(`${date}T12:00:00Z`));
}

function intentLabel(intent: ScheduleIntent): string {
  return intentLabelEnglish(intent);
}

function directionLabel(direction: SchoolRunDirection): string {
  return directionLabelEnglish(direction);
}

function toPatternForm(pattern: SchedulePattern): PatternForm {
  return {
    intent: pattern.intent,
    direction: pattern.direction,
    weekday: pattern.weekday,
    windowStart: pattern.window_start.slice(0, 5),
    windowEnd: pattern.window_end.slice(0, 5),
    areaLabel: pattern.area_label,
    capacity: pattern.capacity,
    startsOn: pattern.starts_on,
  };
}

export function ScheduleHub({
  client,
  userId,
  onModeration,
  onAdminConsole = null,
}: {
  client: SupabaseClient;
  userId: string;
  onModeration: (() => void) | null;
  onAdminConsole?: (() => void) | null;
}) {
  const [view, setView] = useState<ViewMode>('today');
  const [activeChatRoom, setActiveChatRoom] = useState<ChatRoom | null>(null);
  const [overview, setOverview] = useState<ScheduleOverview | null>(null);
  const [form, setForm] = useState<PatternForm>(() => initialForm());
  const [editing, setEditing] = useState<SchedulePattern | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newHouseholdCode, setNewHouseholdCode] = useState<string | null>(null);
  const [householdCodeInput, setHouseholdCodeInput] = useState('');
  const [communityPanel, setCommunityPanel] = useState<CommunityPanel>('market');
  const [suburbEditing, setSuburbEditing] = useState(false);
  const [householdOpen, setHouseholdOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [timePreset, setTimePreset] = useState<'morning' | 'afternoon' | 'custom'>('morning');
  const fallbackStart = useMemo(() => schoolLocalDate(), []);
  const start = overview?.start ?? fallbackStart;
  const timezone = overview?.timezone ?? 'Australia/Melbourne';
  const registeredSuburb = (overview?.schoolSuburb ?? '').trim();

  function selectView(next: ViewMode) {
    setView(next);
    if (next !== 'messages') setActiveChatRoom(null);
  }

  function openChatRoom(room: ChatRoom) {
    setActiveChatRoom(room);
    setView('messages');
  }

  function selectQuickAction(next: ViewMode, focus?: QuickActionFocus) {
    const panelByFocus: Partial<Record<QuickActionFocus, CommunityPanel>> = {
      market: 'market',
      trust: 'trust',
      relay: 'relay',
      deals: 'deals',
      instant: 'pickup',
    };
    if (focus && panelByFocus[focus] && next === 'community') {
      setCommunityPanel(panelByFocus[focus]!);
    } else if (focus === 'deals') {
      setCommunityPanel('deals');
    } else if (focus === 'market') {
      setCommunityPanel('market');
    } else if (focus === 'relay') {
      setCommunityPanel('relay');
    } else if (focus === 'trust') {
      setCommunityPanel('trust');
    }
    selectView(next);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      const target = focus === 'instant'
        ? document.getElementById('instant-board-title')
        : focus === 'deals'
          ? document.getElementById('hot-deals-title')
          : focus === 'trust'
            ? document.getElementById('parent-trust-title')
            : focus === 'market' || focus === 'relay'
              ? document.getElementById('marketplace-title')
              : null;
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  const refresh = useCallback(async () => {
    try {
      const data = await scheduleApi.overview(client);
      setOverview(data);
      setMessage(null);
      const suburb = (data.schoolSuburb ?? '').trim();
      if (suburb) {
        setForm((current) => (current.areaLabel.trim() ? current : { ...current, areaLabel: suburb }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your schedule could not be loaded.');
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  function applyTimePreset(preset: typeof TIME_PRESETS[number] | 'custom') {
    if (preset === 'custom') {
      setTimePreset('custom');
      return;
    }
    setTimePreset(preset.id);
    setForm((current) => ({ ...current, windowStart: preset.start, windowEnd: preset.end }));
  }

  function beginEdit(pattern: SchedulePattern) {
    const next = toPatternForm(pattern);
    setEditing(pattern);
    setForm(next);
    setTimePreset(matchTimePreset(next.windowStart, next.windowEnd));
    setSuburbEditing(true);
  }
  useEffect(() => {
    if (!editing && overview?.start) setForm((current) => current.startsOn === fallbackStart ? { ...current, startsOn: overview.start } : current);
  }, [editing, fallbackStart, overview?.start]);

  const days = useMemo(() => Array.from({ length: 28 }, (_, index) => addDays(start, index)), [start]);
  const todayInstances = overview?.instances.filter((instance) => instance.service_date === start) ?? [];

  async function submitPattern(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isSuburbAreaLabel(form.areaLabel.trim()) || form.windowEnd <= form.windowStart) {
      setMessage('Use a suburb-level label only, and choose an end time after the start time.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (editing) await scheduleApi.updatePattern(client, editing.id, form);
      else await scheduleApi.createPattern(client, form);
      setEditing(null);
      setForm(initialForm(start));
      await refresh();
      setMessage(editing ? 'Your weekly pattern was updated for the next four weeks.' : 'Your weekly pattern was created for the next four weeks.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That pattern could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelInstance(instanceId: string) {
    setBusy(true);
    try {
      await scheduleApi.cancelInstance(client, instanceId);
      await refresh();
      setMessage('That one dated instance was cancelled. A cancellation event is ready for the later trust engine.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That instance could not be cancelled.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelPattern(patternId: string) {
    setBusy(true);
    try {
      const result = await scheduleApi.cancelPattern(client, patternId);
      await refresh();
      setMessage(`The whole pattern was cancelled (${result.cancelledInstances} future instance${result.cancelledInstances === 1 ? '' : 's'}).`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That pattern could not be cancelled.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmHousehold(linkId: string) {
    setBusy(true);
    try {
      await scheduleApi.confirmHousehold(client, linkId);
      await refresh();
      setMessage('Household link confirmed. Future matching will exclude this household pair.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That household link could not be confirmed.');
    } finally {
      setBusy(false);
    }
  }

  async function createHouseholdCode() {
    setBusy(true);
    try {
      const result = await scheduleApi.createHouseholdCode(client);
      setNewHouseholdCode(result.code);
      setCodeCopied(false);
      setMessage('Share this one-time household confirmation code privately. It expires in seven days.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A household confirmation code could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function copyHouseholdCode() {
    if (!newHouseholdCode) return;
    try {
      await navigator.clipboard.writeText(newHouseholdCode);
      setCodeCopied(true);
      setMessage('Confirmation code copied.');
      window.setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      setMessage('Could not copy automatically — select the code and copy manually.');
    }
  }

  async function claimHouseholdCode() {
    if (householdCodeInput.trim().length !== 48) {
      setMessage('Enter the complete household confirmation code.');
      return;
    }
    setBusy(true);
    try {
      await scheduleApi.claimHouseholdCode(client, householdCodeInput.trim());
      setHouseholdCodeInput('');
      await refresh();
      setMessage('Household link confirmed. Future matching will exclude this household pair.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That household confirmation code is unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function exportIcs() {
    setBusy(true);
    try {
      const file = await scheduleApi.confirmedTripsIcs(client);
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'yourturn-confirmed-trips.ics';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage('Your confirmed-trip calendar was exported. It contains no unconfirmed listings.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The calendar could not be exported.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="schedule-shell" aria-labelledby="schedule-title" data-schedule-hub="ready">
      <QuickActions onSelect={selectQuickAction} />
      {/* Locked 5-tab primary navigation. */}
      <ScheduleNav view={view} onSelect={selectView} />
      {(view === 'today' || view === 'calendar') && (
        <button className="text-button schedule-nav__export" type="button" onClick={() => void exportIcs()} disabled={busy}>
          Export confirmed trips (.ics)
        </button>
      )}

      <div className="schedule-hero">
        <p className="eyebrow">Your school-run rhythm</p>
        <h1 id="schedule-title">Plan the next four weeks.</h1>
        <p>Save a weekly “I can help” or “I need help” pattern. Holidays are automatically skipped. Reciprocal options appear in Matches.</p>
      </div>

      {view === 'messages' ? (
        <ChatHub
          client={client}
          userId={userId}
          initialRoom={activeChatRoom}
          onBack={() => selectView('today')}
        />
      ) : null}
      {view === 'community' ? (
        <CommunityHub
          client={client}
          userId={userId}
          initialPanel={communityPanel}
          onBack={() => selectView('today')}
          onOpenChat={openChatRoom}
        />
      ) : null}
      {view === 'matches' ? <MatchHub client={client} onOpenChat={openChatRoom} /> : null}

      {view === 'today' ? (
        <>
          {message && <p className="notice notice--teal" role="status">{message}</p>}
          {!overview && !message && <p className="section-copy">Loading your protected schedule…</p>}
          <section className="day-view" aria-labelledby="today-title">
            <div>
              <p className="eyebrow">{displayDate(start, timezone)}</p>
              <h2 id="today-title">Today’s school-run plan</h2>
            </div>
            {todayInstances.length ? (
              <ul className="instance-list">
                {todayInstances.map((instance) => (
                  <li key={instance.id}>
                    <span className="instance-list__time">{instance.window_start.slice(0, 5)}–{instance.window_end.slice(0, 5)}</span>
                    <div>
                      <strong>{intentLabel(instance.intent)} · {directionLabel(instance.direction)}</strong>
                      <span>{instance.area_label} · {instance.capacity} seat{instance.capacity === 1 ? '' : 's'}</span>
                    </div>
                    <span className={instance.status === 'cancelled' ? 'instance-status instance-status--cancelled' : 'instance-status'}>{statusLabelEnglish(instance.status)}</span>
                    {instance.status === 'open' && (
                      <button className="text-button" disabled={busy} onClick={() => void cancelInstance(instance.id)}>Cancel this date</button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="notice notice--teal">No active school-run listing is planned for today.</p>
            )}
          </section>
          <InstantPickupBoard
            client={client}
            userId={userId}
            defaultSuburb={registeredSuburb}
            onOpenChat={openChatRoom}
          />
          <div className="schedule-grid-layout">
            <form className="schedule-form schedule-form--friendly" onSubmit={submitPattern}>
              <div className="schedule-form__heading">
                <p className="eyebrow">{editing ? 'Edit weekly pattern' : 'New weekly pattern'}</p>
                <h2>{editing ? 'Adjust your recurring listing' : 'Set your availability'}</h2>
              </div>

              <div className="friendly-field" role="group" aria-label="Listing type">
                <span className="friendly-field__label">Listing type</span>
                <div className="segmented-toggle" role="radiogroup" aria-label="Listing type">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.intent === 'can_help'}
                    className={form.intent === 'can_help' ? 'segmented-toggle__btn segmented-toggle__btn--coral' : 'segmented-toggle__btn'}
                    onClick={() => setForm({ ...form, intent: 'can_help' })}
                  >
                    🤝 I can help
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.intent === 'need_help'}
                    className={form.intent === 'need_help' ? 'segmented-toggle__btn segmented-toggle__btn--navy' : 'segmented-toggle__btn'}
                    onClick={() => setForm({ ...form, intent: 'need_help' })}
                  >
                    🙋‍♂️ I need help
                  </button>
                </div>
              </div>

              <div className="friendly-field" role="group" aria-label="School run">
                <span className="friendly-field__label">School run</span>
                <div className="icon-tabs" role="radiogroup" aria-label="School run direction">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.direction === 'dropoff'}
                    className={form.direction === 'dropoff' ? 'icon-tab icon-tab--active' : 'icon-tab'}
                    onClick={() => {
                      setForm({ ...form, direction: 'dropoff', windowStart: '08:00', windowEnd: '08:30' });
                      setTimePreset('morning');
                    }}
                  >
                    <span aria-hidden="true">☀️</span>
                    Drop-off (Morning)
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.direction === 'pickup'}
                    className={form.direction === 'pickup' ? 'icon-tab icon-tab--active' : 'icon-tab'}
                    onClick={() => {
                      setForm({ ...form, direction: 'pickup', windowStart: '15:00', windowEnd: '15:30' });
                      setTimePreset('afternoon');
                    }}
                  >
                    <span aria-hidden="true">🏫</span>
                    Pickup (Afternoon)
                  </button>
                </div>
              </div>

              <div className="friendly-field" role="group" aria-label="Weekday">
                <span className="friendly-field__label">Weekday</span>
                <div className="day-chips" role="radiogroup" aria-label="Weekday">
                  {WEEKDAY_CHIPS.map((day) => (
                    <button
                      key={`${day.value}-${day.title}`}
                      type="button"
                      role="radio"
                      title={day.title}
                      aria-label={day.title}
                      aria-checked={form.weekday === day.value}
                      className={form.weekday === day.value ? 'day-chip day-chip--active' : 'day-chip'}
                      onClick={() => setForm({ ...form, weekday: day.value })}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="friendly-field" role="group" aria-label="Time window">
                <span className="friendly-field__label">Time window</span>
                <div className="time-presets" role="radiogroup" aria-label="Preset times">
                  {TIME_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={timePreset === preset.id}
                      className={timePreset === preset.id ? 'time-preset time-preset--active' : 'time-preset'}
                      onClick={() => applyTimePreset(preset)}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={timePreset === 'custom'}
                    className={timePreset === 'custom' ? 'time-preset time-preset--active' : 'time-preset'}
                    onClick={() => applyTimePreset('custom')}
                  >
                    Custom
                  </button>
                </div>
                {timePreset === 'custom' ? (
                  <div className="schedule-form__times">
                    <label>Start<input type="time" required value={form.windowStart} onChange={(event) => setForm({ ...form, windowStart: event.target.value })} /></label>
                    <label>End<input type="time" required value={form.windowEnd} onChange={(event) => setForm({ ...form, windowEnd: event.target.value })} /></label>
                  </div>
                ) : (
                  <p className="field-help">{form.windowStart} – {form.windowEnd} school-local time</p>
                )}
              </div>

              <div className="friendly-field" role="group" aria-label="Suburb">
                <span className="friendly-field__label">Suburb</span>
                {!suburbEditing && form.areaLabel ? (
                  <div className="suburb-autofill">
                    <span className="suburb-autofill__value">📍 {form.areaLabel}{/\bVIC\b/i.test(form.areaLabel) ? '' : ' VIC'}</span>
                    <button type="button" className="text-button" onClick={() => setSuburbEditing(true)}>Edit</button>
                  </div>
                ) : (
                  <>
                    <input
                      required
                      maxLength={64}
                      value={form.areaLabel}
                      onChange={(event) => setForm({ ...form, areaLabel: event.target.value })}
                      placeholder={registeredSuburb || 'e.g. Docklands'}
                    />
                    {registeredSuburb ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          setForm({ ...form, areaLabel: registeredSuburb });
                          setSuburbEditing(false);
                        }}
                      >
                        Use registered suburb ({registeredSuburb})
                      </button>
                    ) : null}
                  </>
                )}
                <p className="field-help">Suburb or neighbourhood only — never a street address.</p>
              </div>

              <div className="schedule-form__compact-row">
                <label>Seats
                  <select value={form.capacity} onChange={(event) => setForm({ ...form, capacity: Number(event.target.value) })}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((capacity) => <option value={capacity} key={capacity}>{capacity}</option>)}
                  </select>
                </label>
                <label>Starts on
                  <input type="date" required value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} />
                </label>
              </div>

              <button className="primary-button" disabled={busy} type="submit">
                {busy ? 'Saving…' : editing ? 'Save weekly pattern' : 'Create four-week pattern'}
              </button>
              {editing ? (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setSuburbEditing(false);
                    setTimePreset('morning');
                    setForm(initialForm(start, registeredSuburb));
                  }}
                >
                  Cancel editing
                </button>
              ) : null}
            </form>

            <aside className="pattern-panel pattern-panel--friendly" aria-label="Your recurring patterns">
              <p className="eyebrow">Recurring patterns</p>
              <h2>Your weekly setup</h2>
              {overview?.patterns.length ? (
                <ul className="pattern-list">
                  {overview.patterns.map((pattern) => (
                    <li key={pattern.id} className={pattern.is_active ? 'pattern-card pattern-card--sleek' : 'pattern-card pattern-card--sleek pattern-card--cancelled'}>
                      <div className="pattern-card__body">
                        <div className="pattern-card__title-row">
                          <strong>{intentLabel(pattern.intent)} · {directionLabel(pattern.direction)}</strong>
                          <span className={pattern.is_active ? 'status-tag status-tag--active' : 'status-tag status-tag--cancelled'}>
                            {pattern.is_active ? 'Active' : 'Cancelled'}
                          </span>
                        </div>
                        <span>
                          {shortWeekday(pattern.weekday)} · {pattern.window_start.slice(0, 5)}–{pattern.window_end.slice(0, 5)} · {pattern.area_label} · {pattern.capacity} seat{pattern.capacity === 1 ? '' : 's'}
                        </span>
                      </div>
                      {pattern.is_active ? (
                        <div className="pattern-card__actions">
                          <button className="text-button" type="button" onClick={() => beginEdit(pattern)}>Edit</button>
                          <button className="text-button" type="button" onClick={() => void cancelPattern(pattern.id)} disabled={busy}>Cancel</button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="section-copy">No recurring patterns yet.</p>
              )}

              <div className="household-code household-code--compact">
                <button
                  type="button"
                  className="household-code__trigger"
                  aria-expanded={householdOpen}
                  onClick={() => setHouseholdOpen((open) => !open)}
                >
                  🔒 Share Private Confirmation Code
                  <span aria-hidden="true">{householdOpen ? '▾' : '▸'}</span>
                </button>
                {householdOpen ? (
                  <div className="household-code__panel">
                    <p className="field-help">
                      A confirmed household is excluded from matching. Share a one-time code privately — no profile search, address or school data is exposed.
                    </p>
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => void createHouseholdCode()}>
                      Create household confirmation code
                    </button>
                    {newHouseholdCode ? (
                      <div className="household-code__copy-row">
                        <label>
                          Your one-time code
                          <input readOnly aria-label="Your household confirmation code" value={newHouseholdCode} onFocus={(event) => event.currentTarget.select()} />
                        </label>
                        <button
                          type="button"
                          className={codeCopied ? 'household-code__copy household-code__copy--done' : 'household-code__copy'}
                          onClick={() => void copyHouseholdCode()}
                        >
                          {codeCopied ? '✅ Copied!' : '📋 Copy'}
                        </button>
                      </div>
                    ) : null}
                    <label>
                      Enter a household confirmation code
                      <input
                        aria-label="Household confirmation code"
                        value={householdCodeInput}
                        maxLength={48}
                        onChange={(event) => setHouseholdCodeInput(event.target.value)}
                        placeholder="Paste a code shared privately"
                      />
                    </label>
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy || householdCodeInput.trim().length !== 48}
                      onClick={() => void claimHouseholdCode()}
                    >
                      Confirm household code
                    </button>
                  </div>
                ) : null}
              </div>

              {overview?.householdLinks.filter((link) => link.status === 'pending' && link.requested_by !== userId).map((link) => (
                <button className="secondary-button" key={link.id} disabled={busy} onClick={() => void confirmHousehold(link.id)}>
                  Confirm household link
                </button>
              ))}
              {onModeration && <button className="text-button" type="button" onClick={onModeration}>Open moderator review</button>}
              {onAdminConsole && <button className="text-button" type="button" onClick={onAdminConsole}>Open admin console</button>}
            </aside>
          </div>
        </>
      ) : null}

      {view === 'calendar' ? (
        <>
          {message && <p className="notice notice--teal" role="status">{message}</p>}
          {!overview && !message && <p className="section-copy">Loading your protected schedule…</p>}
          <section className="calendar-view" aria-labelledby="calendar-title">
            <div className="calendar-view__head">
              <div>
                <p className="eyebrow">Four-week personal calendar</p>
                <h2 id="calendar-title">Your upcoming dates</h2>
              </div>
              <p>All times are local to {timezone}.</p>
            </div>
            <div className="calendar-list">
              {days.map((date) => {
                const holiday = overview?.calendarPeriods.find((period) => period.period_type === 'holiday' && dateInPeriod(date, period));
                const instances = overview?.instances.filter((instance) => instance.service_date === date) ?? [];
                return (
                  <article className={holiday ? 'calendar-day calendar-day--holiday' : 'calendar-day'} key={date}>
                    <header>
                      <time dateTime={date}>{displayDate(date, timezone)}</time>
                      {holiday ? <span>Holiday · {holiday.label}</span> : <span>{instances.length ? `${instances.length} listing${instances.length === 1 ? '' : 's'}` : 'No listing'}</span>}
                    </header>
                    {holiday ? <p>School-run patterns are skipped automatically.</p> : instances.map((instance) => (
                      <div className="calendar-instance" key={instance.id}>
                        <span>{instance.window_start.slice(0, 5)}–{instance.window_end.slice(0, 5)}</span>
                        <strong>{intentLabel(instance.intent)} · {directionLabel(instance.direction)}</strong>
                        <small>{instance.area_label} · {instance.capacity} seat{instance.capacity === 1 ? '' : 's'}</small>
                        <em className={instance.status === 'cancelled' ? 'instance-status instance-status--cancelled' : 'instance-status'}>{instance.status}</em>
                        {instance.status === 'open' && (
                          <button className="text-button" disabled={busy} onClick={() => void cancelInstance(instance.id)}>Cancel this date</button>
                        )}
                      </div>
                    ))}
                  </article>
                );
              })}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
