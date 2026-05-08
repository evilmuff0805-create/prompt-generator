'use strict';

/**
 * Per-genre camera angle pool weights.
 * Values are relative weights (higher = more likely to be selected).
 * Applied when sampling angles for each shot.
 */
const GENRE_WEIGHTS = {
  Romance: {
    MCU: 3, CU: 3, ECU: 2, MS: 2, MLS: 1,
    OTS: 3, 'Two Shot': 2, 'Profile': 2,
    'Eye Level': 3, 'Dutch Angle': 0,
    'Dolly': 2, 'Static': 2, 'Tracking': 1
  },
  Drama: {
    MCU: 2, CU: 2, MS: 2, MLS: 2, WS: 1,
    OTS: 2, 'Eye Level': 2, 'Low Angle': 1, 'High Angle': 1,
    'Dolly': 1, 'Static': 3, 'Tilt': 1
  },
  Thriller: {
    CU: 2, ECU: 2, MCU: 1, WS: 2, ELS: 1,
    'Dutch Angle': 3, 'Low Angle': 2, 'Bird\'s Eye': 1, 'Worm\'s Eye': 1,
    'Handheld': 3, 'Static': 1, 'Tracking': 2
  },
  Comedy: {
    WS: 3, MLS: 2, MS: 2, MCU: 1,
    'Eye Level': 3, 'High Angle': 1,
    'Static': 3, 'Pan': 1,
    'Three Shot': 2, 'Two Shot': 2
  },
  Action: {
    WS: 2, MLS: 2, ELS: 1, CU: 2, ECU: 1,
    'Low Angle': 3, 'Bird\'s Eye': 2, 'Dutch Angle': 2,
    'Tracking': 3, 'Handheld': 3, 'Crane': 2, 'Dolly': 1
  },
  Horror: {
    ECU: 3, CU: 2, WS: 1, ELS: 1,
    'Dutch Angle': 3, 'Low Angle': 2, 'Worm\'s Eye': 2,
    'Handheld': 3, 'Static': 2,
    'POV': 3, 'Frame-in-Frame': 2
  },
  'Sci-Fi': {
    ELS: 3, WS: 2, MCU: 1, CU: 1,
    'Bird\'s Eye': 3, 'Low Angle': 2, 'Eye Level': 1,
    'Crane': 3, 'Dolly': 2, 'Tracking': 2, 'Static': 1
  },
  Fantasy: {
    ELS: 3, WS: 2, MCU: 1, CU: 1,
    'Low Angle': 3, 'Bird\'s Eye': 2, 'Worm\'s Eye': 1,
    'Crane': 2, 'Dolly': 2, 'Static': 1
  },
  Mystery: {
    MCU: 2, CU: 2, WS: 1, ELS: 1,
    'Dutch Angle': 3, 'High Angle': 2, 'Low Angle': 1,
    'Static': 3, 'Dolly': 2,
    'Frame-in-Frame': 3, 'OTS': 2
  }
};

module.exports = GENRE_WEIGHTS;
