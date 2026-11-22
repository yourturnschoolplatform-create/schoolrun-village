/** Auto-generated Australian schools master (ACARA School Location 2025). */
import raw from './auAllSchools.json';

export type AuSchoolRecord = {
  id: string;
  name: string;
  suburb: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
};

export const AU_ALL_SCHOOLS: readonly AuSchoolRecord[] = raw as AuSchoolRecord[];
