// content.js - WhatsApp KeepAlive Content Script
// NUNCA recarga la pagina. Busca contactos via el buscador de WA y envia.

'use strict';

(function () {
  const LOG_PREFIX = '[WKA]';
  function log(...args) { console.log(LOG_PREFIX, ...args); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // --- Overlay ---

  function showOverlay() {
    let ov = document.getElementById('wka-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'wka-overlay';
      ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:999999;background:rgba(0,0,0,0.05);display:flex;align-items:center;justify-content:center;pointer-events:all;cursor:not-allowed';
      ov.innerHTML = '<div style="background:rgba(0,0,0,0.7);color:white;padding:12px 24px;border-radius:8px;font-family:sans-serif;font-size:14px">Enviando mensaje...</div>';
      document.body.appendChild(ov);
    }
  }

  function hideOverlay() {
    const ov = document.getElementById('wka-overlay');
    if (ov) ov.remove();
  }

  // --- Report result to background ---

  function reportResult(success) {
    try { chrome.runtime.sendMessage({ type: 'message-result', success }); } catch (_) {}
  }

  // --- Detect WhatsApp Web state ---

  async function waitForReady(timeout) {
    timeout = timeout || 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const msgInput = document.querySelector('[contenteditable="true"][data-tab="10"]')
        || document.querySelector('#main [contenteditable="true"]');
      if (msgInput) return 'ready';
      const searchBox = document.querySelector('[data-tab="3"]');
      const sidePanel = document.querySelector('#side');
      if (searchBox || sidePanel) return 'ready';
      const qr = document.querySelector('[data-ref]') || document.querySelector('canvas');
      if (qr) return 'not-logged-in';
      await sleep(1000);
    }
    return 'timeout';
  }

  // --- Find message input ---

  function findMessageInput() {
    return document.querySelector('[contenteditable="true"][data-tab="10"]')
      || document.querySelector('#main [contenteditable="true"]')
      || (document.querySelector('footer') && document.querySelector('footer [contenteditable="true"]'))
      || null;
  }

  async function waitForMessageInput(timeout) {
    timeout = timeout || 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = findMessageInput();
      if (el) return el;
      await sleep(500);
    }
    return null;
  }

  // --- Find send button ---

  async function waitForSendButton(timeout) {
    timeout = timeout || 10000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const btn = document.querySelector('[data-testid="send"]');
      if (btn) return btn;
      const span = document.querySelector('span[data-icon="send"]');
      if (span) return span.closest('button') || span;
      await sleep(300);
    }
    return null;
  }

  // --- Search box helpers ---

  function findSearchBox() {
    return document.querySelector('[data-tab="3"]')
      || document.querySelector('#side [contenteditable="true"]')
      || document.querySelector('[data-testid="chat-list-search"]');
  }

  async function clearAndType(el, text) {
    el.click();
    el.focus();
    await sleep(200);
    if (el.tagName === 'INPUT') {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      await sleep(100);
      document.execCommand('insertText', false, text);
    }
  }

  // --- Find a chat result matching the phone ---

  function findChatResult(phone) {
    const phoneClean = phone.replace(/[^0-9]/g, '');
    const phoneEnd = phoneClean.length > 8 ? phoneClean.slice(-8) : phoneClean;

    // Look in the side panel for matching titles
    const titles = document.querySelectorAll('#pane-side span[title]');
    for (const el of titles) {
      const titleRaw = el.getAttribute('title') || '';
      const titleClean = titleRaw.replace(/[^0-9]/g, '');
      if (titleClean.length < 7) continue;
      const titleEnd = titleClean.length > 8 ? titleClean.slice(-8) : titleClean;

      if (phoneEnd === titleEnd) {
        const row = el.closest('[data-testid="cell-frame-container"]')
          || el.closest('[role="listitem"]')
          || el.closest('[role="row"]')
          || el.closest('div[tabindex="-1"]');
        if (row) return row;
      }
    }
    return null;
  }

  async function waitForChatResult(phone, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = findChatResult(phone);
      if (r) return r;
      await sleep(500);
    }
    return null;
  }

  // --- Find "New Chat" button ---

  function findNewChatButton() {
    // Multiple selectors for different WhatsApp Web versions
    let btn = document.querySelector('[data-testid="compose-btn"]');
    if (btn) return btn;

    const icon = document.querySelector('span[data-icon="new-chat-outline"]');
    if (icon) return icon.closest('button') || icon.closest('div[role="button"]') || icon;

    // aria-label variants (Spanish/English)
    const buttons = document.querySelectorAll('#side button, #side div[role="button"]');
    for (const b of buttons) {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('nuev') || label.includes('new')) return b;
    }

    return null;
  }

  // --- Open a chat with a phone number (NEVER RELOADS) ---

  async function openChat(phone) {
    log('Opening chat with', phone);

    // === Strategy 1: Regular search (existing chats) ===
    const searchBox = findSearchBox();
    if (searchBox) {
      await clearAndType(searchBox, phone);
      await sleep(1500);

      let result = await waitForChatResult(phone, 3000);
      if (result) {
        result.click();
        await sleep(800);
        log('Chat opened via search');
        return true;
      }

      // Clear search before trying next strategy
      await clearAndType(searchBox, '');
      await sleep(300);
      // Press Escape to fully exit search mode
      searchBox.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
      }));
      await sleep(300);
    }

    // === Strategy 2: "New Chat" button (works for non-contacts) ===
    const newChatBtn = findNewChatButton();
    if (newChatBtn) {
      log('Trying New Chat button');
      newChatBtn.click();
      await sleep(1000);

      // The search box might be the same element or a new one
      const newSearchBox = findSearchBox();
      if (newSearchBox) {
        await clearAndType(newSearchBox, phone);
        await sleep(2000);

        let result = await waitForChatResult(phone, 3000);

        // If exact match not found, try first visible result
        // (New Chat search shows "Message +XXX" for non-contacts)
        if (!result) {
          result = document.querySelector('#pane-side [data-testid="cell-frame-container"]')
            || document.querySelector('#pane-side [role="listitem"]');
        }

        if (result) {
          result.click();
          await sleep(1000);
          // Verify chat opened (message input should appear)
          const input = await waitForMessageInput(3000);
          if (input) {
            log('Chat opened via New Chat');
            return true;
          }
        }

        // Close new chat panel
        newSearchBox.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
        }));
        await sleep(300);
      }
    }

    log('Could not open chat with', phone);
    return false;
  }

  // --- Type message and click send ---

  async function typeAndSendMessage(message) {
    const input = await waitForMessageInput(5000);
    if (!input) {
      log('Message input not found');
      return false;
    }

    input.focus();
    await sleep(200);
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
    return true;
  }

  // --- Main send function: search chat + type + send (NO RELOAD) ---

  async function sendToPhone(phone, message) {
    log('sendToPhone:', phone, message.substring(0, 30) + '...');
    showOverlay();

    try {
      const opened = await openChat(phone);
      if (!opened) {
        log('Failed to open chat with', phone);
        hideOverlay();
        reportResult(false);
        return;
      }

      const sent = await typeAndSendMessage(message);
      hideOverlay();
      log(sent ? 'Message sent OK' : 'Failed to type/send');
      reportResult(sent);
    } catch (e) {
      log('Error in sendToPhone:', e);
      hideOverlay();
      reportResult(false);
    }
  }

  // --- Direct send (same chat already open, skip search) ---

  async function directSend(message) {
    log('directSend:', message.substring(0, 30) + '...');
    showOverlay();
    try {
      const sent = await typeAndSendMessage(message);
      hideOverlay();
      reportResult(sent);
    } catch (e) {
      log('Error in directSend:', e);
      hideOverlay();
      reportResult(false);
    }
  }

  // --- Listen for messages from background ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'send-to-phone') {
      const data = msg.data || {};
      sendToPhone(data.phone, data.message);
      sendResponse({ ok: true });
    }
    if (msg.type === 'type-and-send') {
      const data = msg.data || {};
      directSend(data.message);
      sendResponse({ ok: true });
    }
    if (msg.type === 'check-status') {
      const ready = !!(document.querySelector('[data-tab="3"]') || document.querySelector('#side'));
      sendResponse({ status: ready ? 'ready' : 'not-ready' });
    }
    return false;
  });

  // --- Main ---

  async function main() {
    log('Content script loaded:', window.location.href);
    const status = await waitForReady(30000);
    try { chrome.runtime.sendMessage({ type: 'wa-status', status }); } catch (_) {}
  }

  main().catch(e => log('Error main:', e));
})();
