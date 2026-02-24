// content.js - WhatsApp KeepAlive Content Script
// Envia mensajes sin recargar la pagina usando la busqueda de WhatsApp Web.

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
      const searchBox = document.querySelector('[data-tab="3"]');
      const sidePanel = document.querySelector('#side');
      if (searchBox || sidePanel) return 'ready';
      const qr = document.querySelector('[data-ref]') || document.querySelector('canvas');
      if (qr) return 'not-logged-in';
      await sleep(1000);
    }
    return 'timeout';
  }

  // --- Buscar contacto por numero (sin recargar pagina) ---

  async function openChatBySearch(phoneNumber) {
    // Buscar el search box en el sidebar
    let searchBox = document.querySelector('[data-tab="3"]');
    if (!searchBox) {
      searchBox = document.querySelector('#side [contenteditable="true"]');
    }
    if (!searchBox) {
      log('No se encontro search box');
      return false;
    }

    // Limpiar y escribir el numero
    searchBox.focus();
    await sleep(300);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(100);
    document.execCommand('insertText', false, phoneNumber);
    await sleep(2000); // Esperar resultados de busqueda

    // Buscar resultado clickeable
    // WhatsApp Web muestra resultados en elementos con role="listitem" o similar
    const resultSelectors = [
      '[data-testid="cell-frame-container"]',
      '#side .matched-text',
      '#side [role="listitem"]',
      '#side [data-testid="chat-list"] [role="row"]',
    ];

    for (const sel of resultSelectors) {
      const result = document.querySelector(sel);
      if (result) {
        const clickTarget = result.closest('[role="listitem"]') || result.closest('[role="row"]') || result;
        clickTarget.click();
        await sleep(1000);

        // Limpiar busqueda
        searchBox.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        // Presionar Escape para cerrar panel de busqueda
        searchBox.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
        }));

        // Verificar que se abrio un chat (hay input de mensaje)
        const msgInput = await waitForMessageInput(5000);
        if (msgInput) return true;
      }
    }

    log('No se encontro resultado de busqueda para:', phoneNumber);
    return false;
  }

  // --- Esperar input de mensaje ---

  async function waitForMessageInput(timeout) {
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

  // --- Enviar mensaje completo ---

  async function sendMessageToPhone(targetPhone, message) {
    log('Enviando mensaje a:', targetPhone);
    showSendingOverlay();

    try {
      // Delay aleatorio para simular humano
      await sleep(1000 + Math.random() * 2000);

      // Intentar abrir el chat por busqueda (sin recargar)
      const chatOpened = await openChatBySearch(targetPhone);

      if (!chatOpened) {
        log('Busqueda fallo, no se pudo abrir el chat');
        hideSendingOverlay();
        chrome.runtime.sendMessage({ type: 'message-result', success: false });
        return;
      }

      // Esperar el campo de texto del chat
      const input = await waitForMessageInput(10000);
      if (!input) {
        log('No se encontro input de mensaje');
        hideSendingOverlay();
        chrome.runtime.sendMessage({ type: 'message-result', success: false });
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
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }

      await sleep(500);
      hideSendingOverlay();
      log('Mensaje enviado correctamente');
      chrome.runtime.sendMessage({ type: 'message-result', success: true });
    } catch (e) {
      log('Error enviando mensaje:', e);
      hideSendingOverlay();
      try { chrome.runtime.sendMessage({ type: 'message-result', success: false }); } catch (_) {}
    }
  }

  // --- Escuchar mensajes del background ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'send-message') {
      const data = msg.data || {};
      sendMessageToPhone(data.targetPhone, data.message);
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
  }

  main().catch((e) => log('Error main:', e));
})();
