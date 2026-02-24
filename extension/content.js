// content.js - WhatsApp KeepAlive Content Script
// Solo bloquea WhatsApp Web cuando el usuario está conectado a una sala

'use strict';

(function () {
  const LOG_PREFIX = '[WKA]';
  let overlayActive = false;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Overlay (solo se activa cuando estás en una sala) ---

  function addOverlay() {
    if (overlayActive) return;
    const existing = document.getElementById('wka-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'wka-overlay';
    overlay.style.cssText = [
      'position: fixed', 'top: 0', 'left: 0', 'width: 100%', 'height: 100%',
      'z-index: 999999', 'background: rgba(0, 0, 0, 0.05)',
      'display: flex', 'align-items: center', 'justify-content: center',
      'pointer-events: all', 'cursor: not-allowed',
    ].join(';');
    overlay.innerHTML =
      '<div style="background:rgba(0,0,0,0.7);color:white;padding:12px 24px;border-radius:8px;font-family:sans-serif;font-size:14px;">' +
      'WhatsApp KeepAlive - Sesion activa</div>';
    document.body.appendChild(overlay);
    overlayActive = true;
    log('Overlay activado');
  }

  function removeOverlay() {
    const existing = document.getElementById('wka-overlay');
    if (existing) existing.remove();
    overlayActive = false;
    log('Overlay desactivado');
  }

  function disableOverlayTemporarily() {
    const o = document.getElementById('wka-overlay');
    if (o) o.style.pointerEvents = 'none';
  }

  function restoreOverlay() {
    const o = document.getElementById('wka-overlay');
    if (o) o.style.pointerEvents = 'all';
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
      // Delay aleatorio 1-3 seg para simular humano
      await sleep(1000 + Math.random() * 2000);

      const input = await waitForElement(15000);
      if (!input) {
        chrome.runtime.sendMessage({ type: 'message-result', success: false });
        return;
      }

      disableOverlayTemporarily();

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
      chrome.runtime.sendMessage({ type: 'message-result', success: true });
      restoreOverlay();
    } catch (e) {
      log('Error enviando mensaje:', e);
      restoreOverlay();
      try { chrome.runtime.sendMessage({ type: 'message-result', success: false }); } catch (_) {}
    }
  }

  // --- Escuchar mensajes del background ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'activate') {
      addOverlay();
      sendResponse({ ok: true });
    }
    if (msg.type === 'deactivate') {
      removeOverlay();
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

    // Consultar al background si estamos conectados a una sala
    try {
      const state = await chrome.runtime.sendMessage({ type: 'get-state' });
      if (state && state.connected) {
        // Estamos en una sala: activar overlay y procesar mensajes
        addOverlay();
        if (status === 'ready') {
          await handlePendingMessage();
        }
      }
      // Si NO estamos conectados, WhatsApp Web queda libre para usar
    } catch (e) {
      log('Error consultando estado:', e);
    }
  }

  main().catch((e) => log('Error main:', e));
})();
