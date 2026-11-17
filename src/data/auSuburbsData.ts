export interface SchoolItem {
  id: string;
  name: string;
}

export interface SuburbItem {
  id: string;
  name: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
  schools: SchoolItem[];
}

/** Melbourne inner suburbs with real school labels (browser onboarding catalogue). */
export const AU_SUBURBS_DATA: SuburbItem[] = [
  {
    id: 'docklands',
    name: 'Docklands',
    state: 'VIC',
    postcode: '3008',
    lat: -37.8150,
    lng: 144.9460,
    schools: [
      { id: 'docklands-ps', name: 'Docklands Primary School' },
    ],
  },
  {
    id: 'melbourne-cbd',
    name: 'Melbourne (CBD)',
    state: 'VIC',
    postcode: '3000',
    lat: -37.8136,
    lng: 144.9631,
    schools: [
      { id: 'haileybury-city', name: 'Haileybury City Campus' },
      { id: 'simonds-catholic', name: 'Simonds Catholic College' },
    ],
  },
  {
    id: 'southbank',
    name: 'Southbank',
    state: 'VIC',
    postcode: '3006',
    lat: -37.8226,
    lng: 144.9644,
    schools: [
      { id: 'south-melbourne-ps', name: 'South Melbourne Primary School' },
      { id: 'victorian-college-arts', name: 'Victorian College of the Arts Secondary School' },
    ],
  },
  {
    id: 'carlton',
    name: 'Carlton',
    state: 'VIC',
    postcode: '3053',
    lat: -37.8001,
    lng: 144.9671,
    schools: [
      { id: 'carlton-gardens-ps', name: 'Carlton Gardens Primary School' },
      { id: 'carlton-ps', name: 'Carlton Primary School' },
    ],
  },
  {
    id: 'north-melbourne',
    name: 'North Melbourne',
    state: 'VIC',
    postcode: '3051',
    lat: -37.7992,
    lng: 144.9467,
    schools: [
      { id: 'north-melbourne-ps', name: 'North Melbourne Primary School' },
      { id: 'university-high', name: 'The University High School' },
    ],
  },
  {
    id: 'port-melbourne',
    name: 'Port Melbourne',
    state: 'VIC',
    postcode: '3207',
    lat: -37.8399,
    lng: 144.9423,
    schools: [
      { id: 'port-melbourne-ps', name: 'Port Melbourne Primary School' },
      { id: 'port-melbourne-sc', name: 'Port Melbourne Secondary College' },
    ],
  },
  {
    id: 'south-yarra',
    name: 'South Yarra',
    state: 'VIC',
    postcode: '3141',
    lat: -37.8387,
    lng: 144.9912,
    schools: [
      { id: 'south-yarra-ps', name: 'South Yarra Primary School' },
      { id: 'melbourne-high', name: 'Melbourne High School' },
      { id: 'christ-church-grammar', name: 'Christ Church Grammar School' },
    ],
  },
  {
    id: 'richmond',
    name: 'Richmond',
    state: 'VIC',
    postcode: '3121',
    lat: -37.8183,
    lng: 145.0018,
    schools: [
      { id: 'richmond-ps', name: 'Richmond Primary School' },
      { id: 'richmond-west-ps', name: 'Richmond West Primary School' },
      { id: 'richmond-high', name: 'Richmond High School' },
    ],
  },
  {
    id: 'fitzroy',
    name: 'Fitzroy',
    state: 'VIC',
    postcode: '3065',
    lat: -37.7984,
    lng: 144.9786,
    schools: [
      { id: 'fitzroy-ps', name: 'Fitzroy Primary School' },
      { id: 'fitzroy-high', name: 'Fitzroy High School' },
    ],
  },
  {
    id: 'st-kilda',
    name: 'St Kilda',
    state: 'VIC',
    postcode: '3182',
    lat: -37.8676,
    lng: 144.9810,
    schools: [
      { id: 'st-kilda-ps', name: 'St Kilda Primary School' },
      { id: 'st-kilda-park-ps', name: 'St Kilda Park Primary School' },
    ],
  },
];

/** Nearby suburb radius for onboarding geolocation (km). */
export const NEARBY_SUBURB_RADIUS_KM = 5;

/** Two GPS points → distance in km (1 decimal). */
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos((lat1 * Math.PI) / 180)
      * Math.cos((lat2 * Math.PI) / 180)
      * Math.sin(dLon / 2)
      * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(1));
}

export type FlatSchoolOption = {
  id: string;
  displayName: string;
  suburb: string;
  lat: number;
  lng: number;
};

/** Flatten catalogue for cascading suburb → school pickers. */
export function flattenSuburbSchools(
  catalogue: readonly SuburbItem[] = AU_SUBURBS_DATA,
): FlatSchoolOption[] {
  return catalogue.flatMap((suburb) =>
    suburb.schools.map((school) => ({
      id: school.id,
      displayName: school.name,
      suburb: suburb.name,
      lat: suburb.lat,
      lng: suburb.lng,
    })),
  );
}

export type RankedSuburbOption = {
  id: string;
  name: string;
  state: string;
  postcode: string;
  lat: number;
  lng: number;
  distanceKm: number;
  nearby: boolean;
  schools: SchoolItem[];
};

/** Rank suburbs by distance; nearby = within radiusKm. */
export function rankSuburbsNearLocation(
  lat: number,
  lng: number,
  radiusKm: number = NEARBY_SUBURB_RADIUS_KM,
  catalogue: readonly SuburbItem[] = AU_SUBURBS_DATA,
): RankedSuburbOption[] {
  return catalogue
    .map((suburb) => {
      const distanceKm = calculateDistanceKm(lat, lng, suburb.lat, suburb.lng);
      return {
        id: suburb.id,
        name: suburb.name,
        state: suburb.state,
        postcode: suburb.postcode,
        lat: suburb.lat,
        lng: suburb.lng,
        distanceKm,
        nearby: distanceKm <= radiusKm,
        schools: suburb.schools,
      };
    })
    .sort((a, b) => {
      if (a.nearby !== b.nearby) return a.nearby ? -1 : 1;
      if (a.nearby && b.nearby) {
        return a.distanceKm - b.distanceKm || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
}
