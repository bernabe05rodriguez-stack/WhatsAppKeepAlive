// content.js - WhatsApp KeepAlive Content Script
// Runs on every WhatsApp Web page load (document_idle)

'use strict';

(function () {
  const LOG_PREFIX = '[WKA]';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Overlay ---

  function addOverlay() {
    // Remove existing overlay if any
    const existing = document.getElementById('wka-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'wka-overlay';
    overlay.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 0',
      'width: 100%',
      'height: 100%',
      'z-index: 999999',
      'background: rgba(0, 0, 0, 0.05)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'pointer-events: all',
      'cursor: not-allowed',
    ].join(';');

    overlay.innerHTML =
      '<div style="background:rgba(0,0,0,0.7);color:white;padding:12px 24px;border-radius:8px;font-family:sans-serif;font-size:14px;">' +
      'WhatsApp KeepAlive - Sesion activa' +
      '</div>';

    document.body.appendChild(overlay);
    log('Overlay added');
  }

  function removeOverlayTemporarily() {
    const overlay = document.getElementById('wka-overlay');
    if (overlay) {
      overlay.style.pointerEvents = 'none';
    }
  }

  function restoreOverlay() {
    const overlay = document.getElementById('wka-overlay');
    if (overlay) {
      overlay.style.pointerEvents = 'all';
    }
  }

  // --- Wait for WhatsApp Web to be ready ---

  async function waitForReady(timeout) {
    timeout = timeout || 30000;
    const start = Date.now();
    log('Waiting for WhatsApp Web to be ready...');

    while (Date.now() - start < timeout) {
      // Check if logged in: search box or side panel exists
      const searchBox = document.querySelector('[data-tab="3"]');
      const sidePanel = document.querySelector('#side');
      if (searchBox || sidePanel) {
        log('WhatsApp Web is ready (logged in)');
        return 'ready';
      }

      // Check if QR code shown (not logged in)
      const qr = document.querySelector('[data-ref]') || document.querySelector('canvas');
      if (qr) {
        log('WhatsApp Web shows QR code (not logged in)');
        return 'not-logged-in';
      }

      await sleep(1000);
    }

    log('Timeout waiting for WhatsApp Web');
    return 'timeout';
  }

  // --- Wait for compose box ---

  async function waitForElement(timeout) {
    timeout = timeout || 15000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // Try data-tab="10" (compose box)
      let el = document.querySelector('[contenteditable="true"][data-tab="10"]');
      if (el) return el;

      // Fallback: any contenteditable in the main panel (not the search)
      el = document.querySelector('#main [contenteditable="true"]');
      if (el) return el;

      // Fallback: footer contenteditable
      const footer = document.querySelector('footer');
      if (footer) {
        el = footer.querySelector('[contenteditable="true"]');
        if (el) return el;
      }

      await sleep(500);
    }

    return null;
  }

  // --- Wait for send button ---

  async function waitForSendButton(timeout) {
    timeout = timeout || 5000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // data-testid="send" is the most stable selector
      let btn = document.querySelector('[data-testid="send"]');
      if (btn) return btn;

      // Fallback: span with send icon
      const span = document.querySelector('span[data-icon="send"]');
      if (span) {
        const parent = span.closest('button');
        return parent || span;
      }

      await sleep(300);
    }

    return null;
  }

  // --- Handle pending message ---

  async function handlePendingMessage() {
    log('Checking for pending message...');

    let pending;
    try {
      pending = await chrome.runtime.sendMessage({ type: 'get-pending' });
    } catch (e) {
      log('Error getting pending message:', e);
      return;
    }

    if (!pending || !pending.targetPhone) {
      log('No pending message');
      return;
    }

    log('Pending message for:', pending.targetPhone);

    try {
      // Wait random delay (1-3 seconds) to simulate human behavior
      const delay = 1000 + Math.random() * 2000;
      log('Waiting', Math.round(delay), 'ms before typing...');
      await sleep(delay);

      // Wait for the compose box to appear
      log('Waiting for compose box...');
      const input = await waitForElement(15000);

      if (!input) {
        log('Compose box not found, reporting failure');
        chrome.runtime.sendMessage({ type: 'message-result', success: false });
        return;
      }

      log('Compose box found, typing message...');

      // Temporarily disable overlay so clicks/focus work
      removeOverlayTemporarily();

      // Focus the input
      input.focus();
      await sleep(300);

      // Clear any existing text
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(100);

      // Type the message using execCommand (works with React/contenteditable)
      document.execCommand('insertText', false, pending.message);
      log('Message typed');

      await sleep(500);

      // Find and click send button
      const sendBtn = await waitForSendButton(5000);

      if (sendBtn) {
        log('Send button found, clicking...');
        sendBtn.click();
        await sleep(500);
        log('Message sent successfully');
        chrome.runtime.sendMessage({ type: 'message-result', success: true });
      } else {
        log('Send button not found, trying Enter key fallback...');
        // Fallback: simulate Enter key on the input
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        });
        input.dispatchEvent(enterEvent);
        await sleep(500);
        log('Enter key dispatched, assuming message sent');
        chrome.runtime.sendMessage({ type: 'message-result', success: true });
      }

      // Restore overlay
      restoreOverlay();
    } catch (e) {
      log('Error sending message:', e);
      restoreOverlay();
      try {
        chrome.runtime.sendMessage({ type: 'message-result', success: false });
      } catch (_) { /* ignore */ }
    }
  }

  // --- Main ---

  async function main() {
    log('Content script loaded on:', window.location.href);

    // Add overlay to block user interaction
    addOverlay();

    // Wait for WhatsApp Web to be ready
    const status = await waitForReady(30000);

    // Report status to background
    try {
      chrome.runtime.sendMessage({ type: 'wa-status', status: status });
    } catch (e) {
      log('Error reporting WA status:', e);
    }

    if (status === 'ready') {
      // Check and handle pending message
      await handlePendingMessage();
    } else {
      log('WhatsApp Web status:', status);
    }
  }

  // Run main
  main().catch((e) => {
    log('Main error:', e);
  });
})();
