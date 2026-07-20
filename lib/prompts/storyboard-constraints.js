'use strict';

// Shared by the storyboard grid and every Seedance-ready shot prompt. Keeping
// this in one place prevents the still-image and motion contracts from drifting.
const FACE_IDENTITY_CONSTRAINT = 'when a recurring face is visible, preserve facial identity and stable facial geometry frame to frame, including eye spacing, facial proportions, jawline, age cues, and hairline; keep facial landmarks readable through motion with physically plausible motion blur; no face morphing, melting, identity drift, duplicated features, or smeared facial detail';

module.exports = { FACE_IDENTITY_CONSTRAINT };
