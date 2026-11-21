/** Auto-generated AU suburb master (locality + postcode + lat/lng). Source: Matthew Proctor via aus-postcode-suburbs. */
import raw from './auAllSuburbs.json';

export type AuSuburbRecord = {
  id: string;
  name: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
};

export const AU_ALL_SUBURBS: readonly AuSuburbRecord[] = raw as AuSuburbRecord[];
