// content.js - WhatsApp KeepAlive Content Script
// Dos modos de envio:
// 1) URL /send?phone=X&text=Y → detecta y clickea enviar (primera vez, recarga)
// 2) type-and-send → escribe en chat ya abierto y envia (sin recarga)

'use strict';

(function () {
  // Capture URL immediately at injection time, BEFORE WhatsApp's SPA routing changes it
  const INITIAL_URL = window.location.href;

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
    // Use INITIAL_URL captured at injection time, NOT window.location.href
    // WhatsApp's SPA routing may have already changed the URL by now
    const url = new URL(INITIAL_URL);
    if (!url.pathname.includes('/send')) return;

    const phone = url.searchParams.get('phone');
    const text = url.searchParams.get('text');
    if (!phone) return;

    log('URL de envio detectada (initial URL) - phone:', phone);
    showSendingOverlay();

    try {
      // Intentar 1: Esperar a que WhatsApp precargue el texto en el input
      let input = await waitForInputWithText(15000);

      if (input) {
        // Texto precargado encontrado, clickear enviar
        log('Texto precargado encontrado, enviando...');
        await sleep(500);
        const sendBtn = await waitForSendButton(10000);
        if (sendBtn) {
          sendBtn.click();
          await sleep(1500);
          hideSendingOverlay();
          log('Mensaje enviado via URL (click)');
          reportResult(true);
          return;
        }
        // Fallback: Enter
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
        await sleep(1500);
        hideSendingOverlay();
        log('Mensaje enviado via URL (Enter fallback)');
        reportResult(true);
        return;
      }

      // Intentar 2: Si no hay texto precargado pero hay input vacio, escribir directo
      log('No se encontro texto precargado, intentando type-and-send como fallback...');
      input = await waitForMessageInput(10000);
      if (input && text) {
        input.focus();
        await sleep(300);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await sleep(100);
        document.execCommand('insertText', false, text);
        await sleep(500);
        const sendBtn = await waitForSendButton(5000);
        if (sendBtn) {
          sendBtn.click();
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
          }));
        }
        await sleep(1500);
        hideSendingOverlay();
        log('Mensaje enviado via URL (type-and-send fallback)');
        reportResult(true);
        return;
      }

      log('No se pudo enviar: sin input disponible');
      hideSendingOverlay();
      reportResult(false);
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

  // =============================================
  // MODO 3: search-and-send (buscar contacto sin recarga)
  // =============================================

  async function searchAndSend(phone, message) {
    log('search-and-send: phone=' + phone);
    showSendingOverlay();

    try {
      // 1. Find search box in left panel
      let searchBox = document.querySelector('[data-tab="3"]');
      if (!searchBox) {
        log('Search box not found, fallback to URL');
        hideSendingOverlay();
        fallbackToUrl(phone, message);
        return;
      }

      // 2. Click, focus, and clear existing search
      searchBox.click();
      searchBox.focus();
      await sleep(300);
      if (searchBox.tagName === 'INPUT') {
        searchBox.value = '';
        searchBox.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }
      await sleep(200);

      // 3. Type phone number
      if (searchBox.tagName === 'INPUT') {
        searchBox.value = phone;
        searchBox.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, phone);
      }
      await sleep(2000); // Wait for search results to load

      // 4. Find matching result
      const result = await waitForSearchResult(phone, 3000);

      if (!result) {
        log('Contact not found in search, fallback to URL');
        // Clear search before navigating
        searchBox = document.querySelector('[data-tab="3"]');
        if (searchBox) {
          searchBox.focus();
          if (searchBox.tagName === 'INPUT') {
            searchBox.value = '';
            searchBox.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
          }
        }
        await sleep(300);
        hideSendingOverlay();
        fallbackToUrl(phone, message);
        return;
      }

      // 5. Click result to open chat
      log('Found contact, opening chat');
      result.click();
      await sleep(1000);

      // 6. Type and send message
      const input = await waitForMessageInput(5000);
      if (!input) {
        log('Message input not found after opening chat');
        hideSendingOverlay();
        reportResult(false);
        return;
      }

      input.focus();
      await sleep(300);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(100);
      document.execCommand('insertText', false, message);
      await sleep(500);

      const sendBtn = await waitForSendButton(5000);
      if (sendBtn) {
        sendBtn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }

      await sleep(1000);
      hideSendingOverlay();
      log('Message sent via search-and-send');
      reportResult(true);

    } catch (e) {
      log('Error in searchAndSend:', e);
      hideSendingOverlay();
      reportResult(false);
    }
  }

  async function waitForSearchResult(phone, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = findSearchResult(phone);
      if (result) return result;
      await sleep(500);
    }
    return null;
  }

  function findSearchResult(phone) {
    const phoneClean = phone.replace(/[^0-9]/g, '');
    // Use last 10 digits for matching (handles country code variations)
    const phoneEnd = phoneClean.length > 10 ? phoneClean.slice(-10) : phoneClean;

    // Look for span[title] in side panel matching the phone number
    const titles = document.querySelectorAll('#pane-side span[title]');
    for (const el of titles) {
      const titleClean = (el.getAttribute('title') || '').replace(/[^0-9]/g, '');
      if (!titleClean || titleClean.length < 7) continue;
      const titleEnd = titleClean.length > 10 ? titleClean.slice(-10) : titleClean;

      if (phoneEnd === titleEnd) {
        // Get the clickable parent row
        const row = el.closest('[data-testid="cell-frame-container"]')
          || el.closest('[role="listitem"]')
          || el.closest('[role="row"]')
          || el.closest('div[tabindex="-1"]');
        if (row) return row;
      }
    }

    return null;
  }

  function fallbackToUrl(phone, message) {
    log('Fallback: navigating to /send URL (will reload once)');
    window.location.href = 'https://web.whatsapp.com/send?phone=' + phone + '&text=' + encodeURIComponent(message);
    // Page will reload, new content script instance will handle the /send URL via handleSendUrl()
  }

  // --- Escuchar mensajes del background ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'type-and-send') {
      const data = msg.data || {};
      typeAndSend(data.message);
      sendResponse({ ok: true });
    }
    if (msg.type === 'search-and-send') {
      const data = msg.data || {};
      searchAndSend(data.phone, data.message);
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
