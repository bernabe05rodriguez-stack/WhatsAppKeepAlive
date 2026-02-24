// content.js - WhatsApp KeepAlive Content Script
// Dos modos de envio:
// 1) URL /send?phone=X&text=Y → detecta y clickea enviar (primera vez, recarga)
// 2) type-and-send → escribe en chat ya abierto y envia (sin recarga)

'use strict';

(function () {
  const LOG_PREFIX = '[WKA]';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Overlay temporal ---

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
      // Input de mensaje (aparece en URLs /send con chat abierto)
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

  // --- Buscar input de mensaje ---

  function findMessageInput() {
    let el = document.querySelector('[contenteditable="true"][data-tab="10"]');
    if (el) return el;
    el = document.querySelector('#main [contenteditable="true"]');
    if (el) return el;
    const footer = document.querySelector('footer');
    if (footer) {
      el = footer.querySelector('[contenteditable="true"]');
      if (el) return el;
    }
    return null;
  }

  async function waitForMessageInput(timeout) {
    timeout = timeout || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = findMessageInput();
      if (el) return el;
      await sleep(500);
    }
    return null;
  }

  // --- Esperar input con texto precargado (para URL /send) ---

  async function waitForInputWithText(timeout) {
    timeout = timeout || 20000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = findMessageInput();
      if (el && el.textContent.trim().length > 0) return el;
      await sleep(500);
    }
    return null;
  }

  // --- Esperar boton enviar ---

  async function waitForSendButton(timeout) {
    timeout = timeout || 10000;
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

  // --- Reportar resultado al background ---

  function reportResult(success) {
    try {
      chrome.runtime.sendMessage({ type: 'message-result', success: success });
    } catch (_) {}
  }

  // =============================================
  // MODO 1: Handle /send URL (primera vez, con recarga)
  // =============================================

  async function handleSendUrl() {
    const url = new URL(window.location.href);
    if (!url.pathname.includes('/send')) return;

    const phone = url.searchParams.get('phone');
    const text = url.searchParams.get('text');
    if (!phone) return;

    log('URL de envio detectada - phone:', phone);
    showSendingOverlay();

    try {
      // Esperar a que WhatsApp precargue el texto en el input
      const input = await waitForInputWithText(25000);
      if (!input) {
        log('No se encontro input con texto precargado');
        hideSendingOverlay();
        reportResult(false);
        return;
      }

      // Esperar un toque mas y buscar el boton de enviar
      await sleep(500);
      const sendBtn = await waitForSendButton(10000);
      if (sendBtn) {
        sendBtn.click();
        await sleep(1500);
        hideSendingOverlay();
        log('Mensaje enviado via URL');
        reportResult(true);
        return;
      }

      // Fallback: Enter
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
      }));
      await sleep(1500);
      hideSendingOverlay();
      log('Mensaje enviado via Enter (fallback URL)');
      reportResult(true);
    } catch (e) {
      log('Error en handleSendUrl:', e);
      hideSendingOverlay();
      reportResult(false);
    }
  }

  // =============================================
  // MODO 2: type-and-send (sin recarga, chat ya abierto)
  // =============================================

  async function typeAndSend(message) {
    log('type-and-send:', message.substring(0, 40));
    showSendingOverlay();

    try {
      // Buscar input de mensaje (chat ya esta abierto)
      const input = await waitForMessageInput(5000);
      if (!input) {
        log('No se encontro input de mensaje');
        hideSendingOverlay();
        reportResult(false);
        return;
      }

      // Escribir mensaje
      input.focus();
      await sleep(300);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(100);
      document.execCommand('insertText', false, message);
      await sleep(500);

      // Enviar
      const sendBtn = await waitForSendButton(5000);
      if (sendBtn) {
        sendBtn.click();
      } else {
        // Fallback: Enter
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }

      await sleep(1000);
      hideSendingOverlay();
      log('Mensaje enviado via type-and-send');
      reportResult(true);
    } catch (e) {
      log('Error en typeAndSend:', e);
      hideSendingOverlay();
      reportResult(false);
    }
  }

  // --- Escuchar mensajes del background ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'type-and-send') {
      const data = msg.data || {};
      typeAndSend(data.message);
      sendResponse({ ok: true });
    }
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
