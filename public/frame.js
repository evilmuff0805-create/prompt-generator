/* ── Supabase Init ── */
const SUPABASE_URL = 'https://kzlovmcghswprasjaeeo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bG92bWNnaHN3cHJhc2phZWVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1ODkyOTEsImV4cCI6MjA5MzE2NTI5MX0.aivqzUI4jpGgIMEpo6NMy8JL3iBxp49RqoCJU0NLOGE';
const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true }
});

(function () {
  'use strict';

  /* ── DOM refs ── */
  const dropZone        = document.getElementById('frameDropZone');
  const fileInput       = document.getElementById('frameFileInput');
  const video           = document.getElementById('frameVideo');
  const canvas          = document.getElementById('frameCanvas');
  const errorEl         = document.getElementById('frameError');
  const loadingEl       = document.getElementById('frameLoading');
  const loadingText     = document.getElementById('frameLoadingText');
  const resultCard      = document.getElementById('frameResultCard');
  const resultImg       = document.getElementById('frameResultImg');
  const resultMeta      = document.getElementById('frameResultMeta');
  const downloadBtn     = document.getElementById('frameDownloadBtn');
  const clearBtn        = document.getElementById('frameClearBtn');
  const authGate        = document.getElementById('frameAuthGate');
  const authGateSignIn  = document.getElementById('frameAuthGateSignIn');
  const navbar          = document.getElementById('navbar');
  const hamburger       = document.getElementById('hamburger');
  const navMenu         = document.getElementById('navMenu');
  const loginNavBtn     = document.getElementById('loginNavBtn');
  const userProfile     = document.getElementById('userProfile');
  const userAvatar      = document.getElementById('userAvatar');
  const userName        = document.getElementById('userName');

  /* ── State ── */
  let currentBlob = null;
  let currentFilename = 'endframe';

  /* ── Navbar: scroll effect + hamburger ── */
  window.addEventListener('scroll', function () {
    if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 10);
  });

  if (hamburger && navMenu) {
    hamburger.addEventListener('click', function () {
      navMenu.classList.toggle('open');
      hamburger.classList.toggle('open');
    });
  }

  /* ── Auth ── */
  function showAuthGate() {
    if (authGate) authGate.style.display = 'flex';
  }

  function hideAuthGate() {
    if (authGate) authGate.style.display = 'none';
  }

  function updateNavAuth(session) {
    if (!loginNavBtn || !userProfile) return;
    if (session) {
      loginNavBtn.style.display = 'none';
      userProfile.style.display = 'flex';
      const meta = session.user.user_metadata || {};
      if (userName) userName.textContent = meta.full_name || session.user.email || '';
      if (userAvatar) userAvatar.style.display = 'flex';
    } else {
      loginNavBtn.style.display = '';
      userProfile.style.display = 'none';
    }
  }

  // Sign in with Google — redirect back to /frame
  function signIn() {
    sbClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/frame' }
    });
  }

  if (authGateSignIn) authGateSignIn.addEventListener('click', signIn);
  if (loginNavBtn)    loginNavBtn.addEventListener('click', function (e) { e.preventDefault(); signIn(); });

  // Init auth state
  (async function () {
    const { data: { session } } = await sbClient.auth.getSession();
    updateNavAuth(session);
    if (!session) showAuthGate();
  })();

  sbClient.auth.onAuthStateChange(function (event, session) {
    updateNavAuth(session);
    if (session) hideAuthGate();
    else showAuthGate();
  });

  /* ── Error / Loading helpers ── */
  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
    setTimeout(function () { errorEl.style.display = 'none'; }, 8000);
  }

  function setLoading(on, text) {
    if (loadingEl)   loadingEl.style.display = on ? 'block' : 'none';
    if (loadingText && text) loadingText.textContent = text;
  }

  function showResult(blob, filename, width, height) {
    const url = URL.createObjectURL(blob);
    if (resultImg) {
      resultImg.src = url;
      resultImg.onload = function () { URL.revokeObjectURL(url); };
    }
    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    if (resultMeta) resultMeta.textContent = width + ' × ' + height + 'px · PNG · ' + sizeMB + ' MB';
    if (resultCard) resultCard.style.display = 'block';
    currentBlob = blob;
    currentFilename = filename;
  }

  function reset() {
    if (resultCard)  resultCard.style.display  = 'none';
    if (errorEl)     errorEl.style.display     = 'none';
    if (loadingEl)   loadingEl.style.display   = 'none';
    if (resultImg)   resultImg.src             = '';
    currentBlob = null;
    video.src = '';
    video.load();
  }

  /* ── Core: extract last frame ── */
  function extractLastFrame(file) {
    return new Promise(function (resolve, reject) {
      const blobUrl = URL.createObjectURL(file);
      video.src = blobUrl;
      video.load();

      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);

        // Guard: if duration is invalid, reject with a clear error
        if (!video.duration || isNaN(video.duration) || video.duration <= 0) {
          URL.revokeObjectURL(blobUrl);
          reject(new Error('Could not read video duration. This format may not be supported by your browser. Try MP4 or WebM.'));
          return;
        }

        setLoading(true, 'Seeking to last frame…');
        video.currentTime = Math.max(0, video.duration - 0.1);
      });

      video.addEventListener('seeked', function onSeeked() {
        video.removeEventListener('seeked', onSeeked);
        setLoading(true, 'Capturing frame…');

        const w = video.videoWidth;
        const h = video.videoHeight;
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);

        setLoading(true, 'Generating PNG…');
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(blobUrl);
          if (!blob) {
            reject(new Error('Failed to generate PNG from video frame.'));
            return;
          }
          resolve({ blob: blob, width: w, height: h });
        }, 'image/png');
      });

      video.addEventListener('error', function onErr() {
        video.removeEventListener('error', onErr);
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Could not load video. The format may not be supported by your browser.'));
      });
    });
  }

  /* ── Process file ── */
  async function processFile(file) {
    if (!file || !file.type.startsWith('video/')) {
      showError('Please upload a video file (MP4, WebM, MOV).');
      return;
    }

    // Check login
    const { data: { session } } = await sbClient.auth.getSession();
    if (!session) { showAuthGate(); return; }

    reset();
    setLoading(true, 'Loading video…');

    const baseName = file.name.replace(/\.[^.]+$/, '');

    try {
      const { blob, width, height } = await extractLastFrame(file);
      setLoading(false);
      showResult(blob, baseName + '_endframe', width, height);
    } catch (err) {
      setLoading(false);
      showError(err.message || 'Failed to extract frame.');
    }
  }

  /* ── Download ── */
  if (downloadBtn) {
    downloadBtn.addEventListener('click', function () {
      if (!currentBlob) return;
      const url = URL.createObjectURL(currentBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentFilename + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const orig = downloadBtn.textContent;
      downloadBtn.textContent = '✓ Downloaded!';
      setTimeout(function () { downloadBtn.textContent = orig; }, 2000);
    });
  }

  /* ── Clear / Extract New ── */
  if (clearBtn) {
    clearBtn.addEventListener('click', reset);
  }

  /* ── Drop Zone ── */
  if (dropZone) {
    dropZone.addEventListener('click', function () { fileInput && fileInput.click(); });
    dropZone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput && fileInput.click(); }
    });

    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', function () {
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      if (fileInput.files[0]) processFile(fileInput.files[0]);
      fileInput.value = '';
    });
  }

})();
