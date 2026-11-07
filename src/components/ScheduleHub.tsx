import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, dateInPeriod, isSuburbAreaLabel, shortWeekday, type SchoolRunDirection, type ScheduleIntent } from '../../shared/schedules';
import { scheduleApi, type ScheduleOverview, type SchedulePattern, type SchedulePatternInput } from '../lib/schedule-api';
import { CommunityHub } from './CommunityHub';
import { MatchHub } from './MatchHub';

type ViewMode = 'today' | 'calendar' | 'matches' | 'community';

type PatternForm = SchedulePatternInput;

function schoolLocalDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (kind: string) => parts.find((item) => item.type === kind)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function initialForm(startsOn = schoolLocalDate()): PatternForm {
  return { intent: 'can_help', direction: 'pickup', weekday: 1, windowStart: '08:00', windowEnd: '08:30', areaLabel: '', capacity: 1, startsOn };
}

function displayDate(date: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone }).format(new Date(`${date}T12:00:00Z`));
}

function intentLabel(intent: ScheduleIntent): string {
  return intent === 'can_help' ? 'I can help' : 'I need help';
}

function directionLabel(direction: SchoolRunDirection): string {
  return direction === 'pickup' ? 'Pickup' : 'Drop-off';
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

export function ScheduleHub({ client, userId, onModeration }: { client: SupabaseClient; userId: string; onModeration: (() => void) | null }) {
  const [view, setView] = useState<ViewMode>('today');
  const [overview, setOverview] = useState<ScheduleOverview | null>(null);
  const [form, setForm] = useState<PatternForm>(() => initialForm());
  const [editing, setEditing] = useState<SchedulePattern | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newHouseholdCode, setNewHouseholdCode] = useState<string | null>(null);
  const [householdCodeInput, setHouseholdCodeInput] = useState('');
  const fallbackStart = useMemo(() => schoolLocalDate(), []);
  const start = overview?.start ?? fallbackStart;
  const timezone = overview?.timezone ?? 'Australia/Melbourne';

  const refresh = useCallback(async () => {
    try {
      const data = await scheduleApi.overview(client);
      setOverview(data);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Your schedule could not be loaded.');
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);
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
      setMessage('Share this one-time household confirmation code privately. It expires in seven days.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A household confirmation code could not be created.');
    } finally {
      setBusy(false);
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
    <section className="schedule-shell" aria-labelledby="schedule-title">
      <div className="schedule-hero">
        <p className="eyebrow">Your school-run rhythm</p>
        <h1 id="schedule-title">Plan the next four weeks.</h1>
        <p>Save a weekly “I can help” or “I need help” pattern. Holidays are automatically skipped. Reciprocal options appear in Matches.</p>
      </div>

      <div className="schedule-tabs" role="tablist" aria-label="Schedule view">
        <button role="tab" aria-selected={view === 'today'} className={view === 'today' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'} onClick={() => setView('today')}>Today</button>
        <button role="tab" aria-selected={view === 'calendar'} className={view === 'calendar' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'} onClick={() => setView('calendar')}>Calendar</button>
        <button role="tab" aria-selected={view === 'matches'} className={view === 'matches' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'} onClick={() => setView('matches')}>Matches</button>
        <button role="tab" aria-selected={view === 'community'} className={view === 'community' ? 'schedule-tab schedule-tab--active' : 'schedule-tab'} onClick={() => setView('community')}>Community</button>
        <button className="text-button" onClick={() => void exportIcs()} disabled={busy}>Export confirmed trips (.ics)</button>
      </div>

      {view === 'community' ? <CommunityHub client={client} onBack={() => setView('today')} /> : <>
      {message && <p className="notice notice--teal" role="status">{message}</p>}
      {!overview && !message && <p className="section-copy">Loading your protected schedule…</p>}

      <div className="schedule-grid-layout">
        <form className="schedule-form" onSubmit={submitPattern}>
          <div className="schedule-form__heading"><p className="eyebrow">{editing ? 'Edit weekly pattern' : 'New weekly pattern'}</p><h2>{editing ? 'Adjust your recurring listing' : 'Set your availability'}</h2></div>
          <label>Listing type<select value={form.intent} onChange={(event) => setForm({ ...form, intent: event.target.value as ScheduleIntent })}><option value="can_help">I can help</option><option value="need_help">I need help</option></select></label>
          <label>School run<select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as SchoolRunDirection })}><option value="pickup">Pickup</option><option value="dropoff">Drop-off</option></select></label>
          <label>Weekday<select value={form.weekday} onChange={(event) => setForm({ ...form, weekday: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6, 7].map((day) => <option value={day} key={day}>{shortWeekday(day)}</option>)}</select></label>
          <div className="schedule-form__times"><label>Start<input type="time" required value={form.windowStart} onChange={(event) => setForm({ ...form, windowStart: event.target.value })} /></label><label>End<input type="time" required value={form.windowEnd} onChange={(event) => setForm({ ...form, windowEnd: event.target.value })} /></label></div>
          <label>Suburb-level area label<input required maxLength={64} value={form.areaLabel} onChange={(event) => setForm({ ...form, areaLabel: event.target.value })} placeholder="e.g. Carlton" /></label>
          <p className="field-help">Use a suburb or broad neighbourhood only — never an address, street, map pin or coordinates.</p>
          <label>Capacity<select value={form.capacity} onChange={(event) => setForm({ ...form, capacity: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6, 7, 8].map((capacity) => <option value={capacity} key={capacity}>{capacity}</option>)}</select></label>
          <label>Start date<input type="date" required value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></label>
          <button className="primary-button" disabled={busy} type="submit">{busy ? 'Saving…' : editing ? 'Save weekly pattern' : 'Create four-week pattern'}</button>
          {editing && <button className="text-button" type="button" onClick={() => { setEditing(null); setForm(initialForm(start)); }}>Cancel editing</button>}
        </form>

        <aside className="pattern-panel" aria-label="Your recurring patterns">
          <p className="eyebrow">Recurring patterns</p>
          <h2>Your weekly setup</h2>
          {overview?.patterns.length ? <ul className="pattern-list">{overview.patterns.map((pattern) => <li key={pattern.id} className="pattern-card"><div><strong>{intentLabel(pattern.intent)} · {directionLabel(pattern.direction)}</strong><span>{shortWeekday(pattern.weekday)} · {pattern.window_start.slice(0, 5)}–{pattern.window_end.slice(0, 5)} · {pattern.area_label} · {pattern.capacity} seat{pattern.capacity === 1 ? '' : 's'}</span>{!pattern.is_active && <em>Cancelled</em>}</div>{pattern.is_active && <div className="pattern-card__actions"><button className="text-button" onClick={() => { setEditing(pattern); setForm(toPatternForm(pattern)); }}>Edit</button><button className="text-button" onClick={() => void cancelPattern(pattern.id)} disabled={busy}>Cancel whole pattern</button></div>}</li>)}</ul> : <p className="section-copy">No recurring patterns yet.</p>}
          <div className="household-code">
            <p className="schedule-note">A confirmed household will be excluded from future matching. Create a one-time code to share privately with the other verified parent; no profile search, address or school data is exposed.</p>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void createHouseholdCode()}>Create household confirmation code</button>
            {newHouseholdCode && <label>Your one-time code<input readOnly aria-label="Your household confirmation code" value={newHouseholdCode} onFocus={(event) => event.currentTarget.select()} /></label>}
            <label>Enter a household confirmation code<input aria-label="Household confirmation code" value={householdCodeInput} maxLength={48} onChange={(event) => setHouseholdCodeInput(event.target.value)} placeholder="Paste a code shared privately" /></label>
            <button className="text-button" type="button" disabled={busy || householdCodeInput.trim().length !== 48} onClick={() => void claimHouseholdCode()}>Confirm household code</button>
          </div>
          {overview?.householdLinks.filter((link) => link.status === 'pending' && link.requested_by !== userId).map((link) => <button className="secondary-button" key={link.id} disabled={busy} onClick={() => void confirmHousehold(link.id)}>Confirm household link</button>)}
          {onModeration && <button className="text-button" onClick={onModeration}>Open moderator review</button>}
        </aside>
      </div>

      {view === 'matches' ? <MatchHub client={client} /> : view === 'today' ? <section className="day-view" aria-labelledby="today-title"><div><p className="eyebrow">{displayDate(start, timezone)}</p><h2 id="today-title">Today’s school-run plan</h2></div>{todayInstances.length ? <ul className="instance-list">{todayInstances.map((instance) => <li key={instance.id}><span className="instance-list__time">{instance.window_start.slice(0, 5)}–{instance.window_end.slice(0, 5)}</span><div><strong>{intentLabel(instance.intent)} · {directionLabel(instance.direction)}</strong><span>{instance.area_label} · {instance.capacity} seat{instance.capacity === 1 ? '' : 's'}</span></div><span className={instance.status === 'cancelled' ? 'instance-status instance-status--cancelled' : 'instance-status'}>{instance.status}</span>{instance.status === 'open' && <button className="text-button" disabled={busy} onClick={() => void cancelInstance(instance.id)}>Cancel this date</button>}</li>)}</ul> : <p className="notice notice--teal">No active school-run listing is planned for today.</p>}</section> : <section className="calendar-view" aria-labelledby="calendar-title"><div className="calendar-view__head"><div><p className="eyebrow">Four-week personal calendar</p><h2 id="calendar-title">Your upcoming dates</h2></div><p>All times are local to {timezone}.</p></div><div className="calendar-list">{days.map((date) => { const holiday = overview?.calendarPeriods.find((period) => period.period_type === 'holiday' && dateInPeriod(date, period)); const instances = overview?.instances.filter((instance) => instance.service_date === date) ?? []; return <article className={holiday ? 'calendar-day calendar-day--holiday' : 'calendar-day'} key={date}><header><time dateTime={date}>{displayDate(date, timezone)}</time>{holiday ? <span>Holiday · {holiday.label}</span> : <span>{instances.length ? `${instances.length} listing${instances.length === 1 ? '' : 's'}` : 'No listing'}</span>}</header>{holiday ? <p>School-run patterns are skipped automatically.</p> : instances.map((instance) => <div className="calendar-instance" key={instance.id}><span>{instance.window_start.slice(0, 5)}–{instance.window_end.slice(0, 5)}</span><strong>{intentLabel(instance.intent)} · {directionLabel(instance.direction)}</strong><small>{instance.area_label} · {instance.capacity} seat{instance.capacity === 1 ? '' : 's'}</small><em className={instance.status === 'cancelled' ? 'instance-status instance-status--cancelled' : 'instance-status'}>{instance.status}</em>{instance.status === 'open' && <button className="text-button" disabled={busy} onClick={() => void cancelInstance(instance.id)}>Cancel this date</button>}</div>)}</article>; })}</div></section>}
      </>}
    </section>
  );
}
