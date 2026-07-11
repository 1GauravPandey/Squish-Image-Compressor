/* ============================================================================
   script.js — Frontend logic for the Squish image compressor.

   Responsibilities:
   1. Handle drag-and-drop + click-to-browse file selection.
   2. Validate the file client-side (quick feedback before hitting the server).
   3. Send the file + quality slider value to the Flask backend via fetch().
   4. Render the "before/after" preview and file size comparison.
   5. Wire up the download button and the "choose another image" reset flow.
============================================================================ */

// ---------------------------------------------------------------------------
// Grab references to all the DOM elements we'll need to read from or update.
// Doing this once up top avoids repeated document.getElementById() calls.
// ---------------------------------------------------------------------------
const dropZone           = document.getElementById('drop-zone');
const fileInput          = document.getElementById('file-input');
const errorMessage       = document.getElementById('error-message');

const uploadSection      = document.getElementById('upload-section');
const workspaceSection   = document.getElementById('workspace-section');

const qualitySlider       = document.getElementById('quality-slider');
const qualityValueLabel   = document.getElementById('quality-value');

const gaugeNeedle         = document.getElementById('gauge-needle');
const gaugeFill           = document.getElementById('gauge-fill');

const loadingIndicator   = document.getElementById('loading-indicator');

const originalPreviewImg  = document.getElementById('original-preview');
const compressedPreviewImg= document.getElementById('compressed-preview');
const originalSizeLabel   = document.getElementById('original-size');
const compressedSizeLabel = document.getElementById('compressed-size');

const savingsBanner       = document.getElementById('savings-banner');
const savingsText         = document.getElementById('savings-text');

const resetButton         = document.getElementById('reset-button');
const downloadButton      = document.getElementById('download-button');

// Keep track of the currently selected File object, and a debounce timer
// so we don't spam the server with a request on every single pixel the
// slider moves.
let currentFile = null;
let debounceTimer = null;

// Client-side validation constants (kept in sync with the backend's rules).
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff'];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// ============================================================================
// GAUGE (the light-meter needle + arc above the slider)
// ============================================================================
// The gauge is purely decorative/visual — the real, keyboard- and
// touch-operable control is the <input type="range"> underneath it. We just
// keep the two in sync every time the slider value changes.
const GAUGE_ARC_LENGTH = gaugeFill ? gaugeFill.getTotalLength() : 0;

if (gaugeFill) {
  // Draw the arc as one long dash the same length as the path, so we can
  // reveal a fraction of it by shifting the dash offset (the same trick
  // used for circular progress rings).
  gaugeFill.style.strokeDasharray = `${GAUGE_ARC_LENGTH}`;
}

function updateGauge(value) {
  const fraction = Math.max(0, Math.min(1, (value - 1) / 99)); // 1-100 -> 0-1

  // Needle sweeps from -90deg (fully left, lowest quality) to +90deg
  // (fully right, highest quality), pivoting around the hub at (100,100).
  const angle = fraction * 180 - 90;
  if (gaugeNeedle) {
    gaugeNeedle.style.transform = `rotate(${angle}deg)`;
  }

  // Reveal that same fraction of the arc as the "filled" amber track.
  if (gaugeFill) {
    gaugeFill.style.strokeDashoffset = `${GAUGE_ARC_LENGTH * (1 - fraction)}`;
  }
}

// ============================================================================
// DRAG AND DROP LOGIC
// ============================================================================
// The drop zone needs to react to 4 drag events:
//   dragenter / dragover -> fires repeatedly while a file is dragged over it
//   dragleave            -> fires when the dragged file leaves the zone
//   drop                 -> fires when the user releases the file on the zone
//
// By default, browsers will try to OPEN a dropped file as a new page/download
// instead of letting our JS handle it. Calling e.preventDefault() on every
// one of these events is what stops that default browser behavior.
// ----------------------------------------------------------------------------

['dragenter', 'dragover'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();  // Stop the browser from opening the file itself
    e.stopPropagation();
    dropZone.classList.add('drop-zone--active'); // Trigger the CSS "highlight" state
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drop-zone--active'); // Remove the highlight
  });
});

// The actual "drop" event is where we get access to the file(s) the user
// dragged in, via e.dataTransfer.files (a FileList, just like a normal
// <input type="file"> would give us).
dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    handleFileSelection(files[0]);
  }
});

// Clicking anywhere on the drop zone opens the native file picker by
// programmatically clicking the hidden <input type="file">.
dropZone.addEventListener('click', () => {
  fileInput.click();
});

// The drop zone is also a focusable, ARIA "button" (see its tabindex/role
// in the HTML), so keyboard users can press Enter or Space to open the
// file picker without needing a mouse to drag-and-drop.
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); // Stop the page from scrolling on Space
    fileInput.click();
  }
});

// When the user picks a file via the native file picker dialog, the
// <input>'s "change" event fires with the chosen file(s) in fileInput.files.
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    handleFileSelection(fileInput.files[0]);
  }
});

// ============================================================================
// FILE VALIDATION + INITIAL PREVIEW
// ============================================================================
function handleFileSelection(file) {
  hideError();

  // --- Client-side validation (fast feedback; server re-validates too) -----
  if (!ALLOWED_TYPES.includes(file.type)) {
    showError('Unsupported file type. Please upload a PNG, JPG, WEBP, BMP, GIF, or TIFF image.');
    return;
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    showError('File is too large. Maximum upload size is 20MB.');
    return;
  }

  currentFile = file;

  // Show the "original" preview immediately using a local object URL —
  // this doesn't require the server at all, so it's instant.
  const localUrl = URL.createObjectURL(file);
  originalPreviewImg.src = localUrl;
  originalSizeLabel.textContent = formatBytes(file.size);

  // Switch from the "upload" view to the "workspace" view.
  uploadSection.hidden = true;
  workspaceSection.hidden = false;

  // Kick off the first compression pass at the current slider value.
  compressImage();
}

// ============================================================================
// QUALITY SLIDER
// ============================================================================
qualitySlider.addEventListener('input', () => {
  qualityValueLabel.innerHTML = `${qualitySlider.value}<span class="readout__unit">%</span>`;
  updateGauge(Number(qualitySlider.value));

  // Debounce: wait 300ms after the user stops moving the slider before
  // actually sending a new request. Otherwise every tiny drag movement
  // would fire a separate fetch() call, hammering the server.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    compressImage();
  }, 300);
});

// Set the gauge's initial position to match the slider's starting value
// as soon as the page loads (rather than waiting for the first "input").
updateGauge(Number(qualitySlider.value));

// ============================================================================
// SENDING THE IMAGE TO THE BACKEND (fetch / AJAX)
// ============================================================================
async function compressImage() {
  if (!currentFile) return;

  loadingIndicator.hidden = false;
  savingsBanner.hidden = true;

  // FormData lets us bundle a binary file + regular form fields together,
  // exactly like an HTML <form enctype="multipart/form-data"> would.
  const formData = new FormData();
  formData.append('image', currentFile);
  formData.append('quality', qualitySlider.value);

  try {
    // fetch() sends the POST request. We don't set a Content-Type header
    // manually — the browser sets the correct
    // "multipart/form-data; boundary=..." header automatically when the
    // body is a FormData object.
    const response = await fetch('/compress', {
      method: 'POST',
      body: formData,
    });

    // The server always responds with JSON (even on errors), so we parse
    // that regardless of whether response.ok is true or false.
    const data = await response.json();

    if (!response.ok || !data.success) {
      showError(data.error || 'Something went wrong while compressing the image.');
      loadingIndicator.hidden = true;
      return;
    }

    // --- Render the results returned by the server -----------------------
    compressedPreviewImg.src = data.preview;          // base64 data URL
    compressedSizeLabel.textContent = formatBytes(data.compressed_size);

    // Point the download button at the server's download URL for this
    // specific compressed file.
    downloadButton.href = data.download_url;
    downloadButton.setAttribute('download', `compressed-${data.filename}`);

    // Show a friendly "you saved X%" message.
    const savingsPercent = Math.round(
      (1 - data.compressed_size / data.original_size) * 100
    );
    if (savingsPercent > 0) {
      savingsText.textContent = `${savingsPercent}% smaller than the original`;
    } else {
      savingsText.textContent = `Compressed file is about the same size as the original`;
    }
    savingsBanner.hidden = false;

  } catch (err) {
    // This catches network failures (server down, no internet, etc.) —
    // distinct from the "server responded but with an error" case above.
    showError('Could not reach the server. Please check your connection and try again.');
  } finally {
    loadingIndicator.hidden = true;
  }
}

// ============================================================================
// RESET FLOW ("Choose another image")
// ============================================================================
resetButton.addEventListener('click', () => {
  currentFile = null;
  fileInput.value = '';               // Clear the native file input
  originalPreviewImg.src = '';
  compressedPreviewImg.src = '';
  originalSizeLabel.textContent = '—';
  compressedSizeLabel.textContent = '—';
  savingsBanner.hidden = true;
  qualitySlider.value = 80;
  qualityValueLabel.innerHTML = '80<span class="readout__unit">%</span>';
  updateGauge(80);

  workspaceSection.hidden = true;
  uploadSection.hidden = false;
  hideError();
});

// ============================================================================
// BUTTON RIPPLE — a small, tactile click response on the primary actions.
// ============================================================================
document.querySelectorAll('.button').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height);

    ripple.className = 'button__ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;

    btn.appendChild(ripple);
    // Clean up the ripple element once its animation finishes so we don't
    // leave a growing pile of dead <span> elements in the DOM.
    ripple.addEventListener('animationend', () => ripple.remove());
  });
});

// ============================================================================
// SMALL HELPERS
// ============================================================================

// Converts a raw byte count into a human-readable string, e.g. 1532441 -> "1.46 MB"
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function hideError() {
  errorMessage.hidden = true;
  errorMessage.textContent = '';
}
