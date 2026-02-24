// content.js - WhatsApp KeepAlive Content Script
// WhatsApp Web queda libre para usar. Solo se bloquea brevemente al enviar un mensaje automatico.

'use strict';

(function () {
  const LOG_PREFIX = '[WKA]';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Overlay temporal (solo durante envio de mensaje) ---

  function showSendingOverlay() {
    let overlay = document.getElementById('wka-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'wka-overlay';
      overlay.style.cssText = [
        'position: fixed', 'top: 0', 'left: 0', 'width: 100%', 'height: 100%',
        'z-index: 999999', 'background: rgba(0, 0, 0, 0.05)',
        'display: flex', 'align-items: center', 'justify-content: center',
        'pointer-events: all', 'cursor: not-allowed',
      ].join(';');
      overlay.innerHTML =
        '<div style="background:rgba(0,0,0,0.7);color:white;padding:12px 24px;border-radius:8px;font-family:sans-serif;font-size:14px;">' +
        'Enviando mensaje...</div>';
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    overlay.style.pointerEvents = 'all';
  }

  function hideSendingOverlay() {
    const overlay = document.getElementById('wka-overlay');
    if (overlay) overlay.remove();
  }

  // --- Detectar estado de WhatsApp Web ---

  async function waitForReady(timeout) {
    timeout = timeout || 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const searchBox = document.querySelector('[data-tab="3"]');
      const sidePanel = document.querySelector('#side');
      if (searchBox || sidePanel) return 'ready';
      const qr = document.querySelector('[data-ref]') || document.querySelector('canvas');
      if (qr) return 'not-logged-in';
      await sleep(1000);
    }
    return 'timeout';
  }

  // --- Esperar campo de texto ---

  async function waitForElement(timeout) {
    timeout = timeout || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let el = document.querySelector('[contenteditable="true"][data-tab="10"]');
      if (el) return el;
      el = document.querySelector('#main [contenteditable="true"]');
      if (el) return el;
      const footer = document.querySelector('footer');
      if (footer) {
        el = footer.querySelector('[contenteditable="true"]');
        if (el) return el;
      }
      await sleep(500);
    }
    return null;
  }

  // --- Esperar boton enviar ---

  async function waitForSendButton(timeout) {
    timeout = timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      let btn = document.querySelector('[data-testid="send"]');
      if (btn) return btn;
      const span = document.querySelector('span[data-icon="send"]');
      if (span) return span.closest('button') || span;
      await sleep(300);
    }
    return null;
  }

  // --- Enviar mensaje pendiente ---

  async function handlePendingMessage() {
    let pending;
    try {
      pending = await chrome.runtime.sendMessage({ type: 'get-pending' });
    } catch (e) {
      log('Error obteniendo mensaje pendiente:', e);
      return;
    }
    if (!pending || !pending.targetPhone) return;

    log('Mensaje pendiente para:', pending.targetPhone);

    try {
      showSendingOverlay();

      // Delay aleatorio 1-3 seg para simular humano
      await sleep(1000 + Math.random() * 2000);

      const input = await waitForElement(15000);
      if (!input) {
        hideSendingOverlay();
        chrome.runtime.sendMessage({ type: 'message-result', success: false });
        return;
      }

      input.focus();
      await sleep(300);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(100);
      document.execCommand('insertText', false, pending.message);
      await sleep(500);

      const sendBtn = await waitForSendButton(5000);
      if (sendBtn) {
        sendBtn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }

      await sleep(500);
      hideSendingOverlay();
      chrome.runtime.sendMessage({ type: 'message-result', success: true });
    } catch (e) {
      log('Error enviando mensaje:', e);
      hideSendingOverlay();
      try { chrome.runtime.sendMessage({ type: 'message-result', success: false }); } catch (_) {}
    }
  }

  // --- Escuchar mensajes del background ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'send-now') {
      // Background pide enviar un mensaje, procesarlo
      handlePendingMessage();
      sendResponse({ ok: true });
    }
    return false;
  });

  // --- Main ---

  async function main() {
    log('Content script cargado:', window.location.href);

    // Reportar estado de WA al background
    const status = await waitForReady(30000);
    try {
      chrome.runtime.sendMessage({ type: 'wa-status', status: status });
    } catch (e) {}

    // Si hay un mensaje pendiente, enviarlo
    if (status === 'ready') {
      await handlePendingMessage();
    }
  }

  main().catch((e) => log('Error main:', e));
})();
