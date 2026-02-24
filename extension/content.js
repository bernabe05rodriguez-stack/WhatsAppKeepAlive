// content.js - WhatsApp KeepAlive Content Script
// Detecta URL de envio (/send?phone=X&text=Y) y envia el mensaje automaticamente.

'use strict';

(function () {
  const LOG_PREFIX = '[WKA]';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Overlay temporal (solo durante envio) ---

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
      // Input de mensaje (aparece en URLs /send)
      const msgInput = document.querySelector('[contenteditable="true"][data-tab="10"]')
        || document.querySelector('#main [contenteditable="true"]');
      if (msgInput) return 'ready';
      // Search box o side panel (WA Web normal)
      const searchBox = document.querySelector('[data-tab="3"]');
      const sidePanel = document.querySelector('#side');
      if (searchBox || sidePanel) return 'ready';
      // QR code (no logueado)
      const qr = document.querySelector('[data-ref]') || document.querySelector('canvas');
      if (qr) return 'not-logged-in';
      await sleep(1000);
    }
    return 'timeout';
  }

  // --- Esperar boton enviar ---

  async function waitForSendButton(timeout) {
    timeout = timeout || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      // Boton de enviar por data-testid
      let btn = document.querySelector('[data-testid="send"]');
      if (btn) return btn;
      // Boton de enviar por icono
      const span = document.querySelector('span[data-icon="send"]');
      if (span) return span.closest('button') || span;
      await sleep(500);
    }
    return null;
  }

  // --- Handle /send URL (envio automatico) ---

  async function handleSendUrl() {
    const url = new URL(window.location.href);
    if (!url.pathname.includes('/send')) return;

    const phone = url.searchParams.get('phone');
    const text = url.searchParams.get('text');
    if (!phone) return;

    log('URL de envio detectada - phone:', phone, 'text:', text ? text.substring(0, 40) + '...' : '(vacio)');
    showSendingOverlay();

    try {
      // Esperar a que WhatsApp cargue el chat y precargue el texto
      await sleep(3000);

      // Esperar al boton de enviar (aparece cuando el texto esta precargado)
      const sendBtn = await waitForSendButton(20000);
      if (sendBtn) {
        sendBtn.click();
        await sleep(1500);
        hideSendingOverlay();
        log('Mensaje enviado correctamente');
        try { chrome.runtime.sendMessage({ type: 'message-result', success: true }); } catch (_) {}
        return;
      }

      // Fallback: buscar input y presionar Enter
      const input = document.querySelector('[contenteditable="true"][data-tab="10"]')
        || document.querySelector('#main [contenteditable="true"]');
      if (input && input.textContent.trim()) {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
        await sleep(1500);
        hideSendingOverlay();
        log('Mensaje enviado via Enter');
        try { chrome.runtime.sendMessage({ type: 'message-result', success: true }); } catch (_) {}
        return;
      }

      log('No se pudo enviar - no se encontro boton de enviar ni texto precargado');
      hideSendingOverlay();
      try { chrome.runtime.sendMessage({ type: 'message-result', success: false }); } catch (_) {}
    } catch (e) {
      log('Error en handleSendUrl:', e);
      hideSendingOverlay();
      try { chrome.runtime.sendMessage({ type: 'message-result', success: false }); } catch (_) {}
    }
  }

  // --- Escuchar mensajes del background ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'check-status') {
      const searchBox = document.querySelector('[data-tab="3"]');
      const sidePanel = document.querySelector('#side');
      const isReady = !!(searchBox || sidePanel);
      sendResponse({ status: isReady ? 'ready' : 'not-ready' });
    }
    return false;
  });

  // --- Main ---

  async function main() {
    log('Content script cargado:', window.location.href);

    const status = await waitForReady(30000);
    try {
      chrome.runtime.sendMessage({ type: 'wa-status', status: status });
    } catch (e) {}

    // Si estamos en una URL /send, enviar automaticamente
    if (status === 'ready') {
      await handleSendUrl();
    }
  }

  main().catch((e) => log('Error main:', e));
})();
