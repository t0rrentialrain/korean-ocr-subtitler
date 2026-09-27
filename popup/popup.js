// Popup — thin remote control that talks to the content script on the active tab.

const els = {
  notYoutube: document.getElementById('notYoutube'),
  controls: document.getElementById('controls'),
  regionText: document.getElementById('regionText'),
  lineText: document.getElementById('lineText'),
  preview: document.getElementById('preview'),
  setRegion: document.getElementById('setRegion'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  download: document.getElementById('download'),
  clear: document.getElementById('clear'),
};

let activeTabId = null;

function send(type) {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type }, () => {
    // Ignore chrome.runtime.lastError (e.g. tab navigated away); just refresh.
    setTimeout(refresh, 150);
  });
}

function refresh() {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { type: 'GET_STATE' }, (state) => {
    if (chrome.runtime.lastError || !state) {
      // The URL matched, but the content script didn't answer — almost always
      // because this tab was already open before the extension was loaded/reloaded.
      els.notYoutube.classList.remove('hidden');
      els.notYoutube.querySelector('p').textContent =
        "Couldn't reach the page script. Try refreshing this YouTube tab (the extension only injects on page load).";
      els.controls.classList.add('hidden');
      return;
    }
    els.notYoutube.classList.add('hidden');
    els.controls.classList.remove('hidden');
    els.regionText.textContent = `Region: ${state.regionSet ? 'set ✅' : 'not set'}`;
    els.lineText.textContent = `Lines: ${state.lineCount}`;
    els.preview.textContent = state.lastText ? `“${state.lastText}”` : '';
    els.start.disabled = !state.regionSet || state.capturing;
    els.stop.disabled = !state.capturing;
    els.download.disabled = state.lineCount === 0;
  });
}

els.setRegion.addEventListener('click', () => { window.close(); send('SET_REGION'); });
els.start.addEventListener('click', () => send('START'));
els.stop.addEventListener('click', () => send('STOP'));
els.download.addEventListener('click', () => send('DOWNLOAD'));
els.clear.addEventListener('click', () => send('CLEAR'));

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab || !/^https:\/\/www\.youtube\.com\/watch/.test(tab.url || '')) {
    els.notYoutube.classList.remove('hidden');
    return;
  }
  activeTabId = tab.id;
  refresh();
});
