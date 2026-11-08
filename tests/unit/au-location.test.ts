import { describe, expect, it } from 'vitest';
import {
  formatSchoolLocationChip,
  intentLabelEnglish,
  resolveSchoolLocation,
  schoolSectorBadge,
  statusLabelEnglish,
} from '../../shared/au-location';

describe('Australian location helpers', () => {
  it('formats suburb · school chips and English badges', () => {
    const carlton = resolveSchoolLocation({
      displayName: 'Carlton Public School',
      suburb: 'Carlton',
      schoolSector: 'primary',
    });
    expect(formatSchoolLocationChip(carlton)).toBe('Carlton · Carlton Public School');
    expect(schoolSectorBadge(carlton.schoolSector)).toBe('Primary School');

    const chatswood = resolveSchoolLocation({
      displayName: 'Chatswood High School',
      suburb: 'Chatswood',
      schoolSector: 'secondary',
    });
    expect(formatSchoolLocationChip(chatswood)).toBe('Chatswood · Chatswood High School');
    expect(schoolSectorBadge(chatswood.schoolSector)).toBe('Secondary School');

    expect(intentLabelEnglish('need_help')).toBe('I need help');
    expect(intentLabelEnglish('can_help')).toBe('I can help');
    expect(statusLabelEnglish('open')).toBe('Open');
    expect(statusLabelEnglish('matched')).toBe('Matched');
  });
});
